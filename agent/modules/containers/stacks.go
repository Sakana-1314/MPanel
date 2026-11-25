package containers

import (
	"context"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/sakana-1314/mpanel/core/httpapi"
	"github.com/sakana-1314/mpanel/core/protocol"
)

// stackManager owns the stacks directory. Compose files are only ever read or
// written at <data>/stacks/<name>/compose.yaml after a realpath containment
// check; symlinked directories/files are rejected outright.
type stackManager struct {
	root string
}

func newStackManager(dataDir string) *stackManager {
	root := filepath.Join(dataDir, "stacks")
	if strings.TrimSpace(dataDir) == "" {
		root = "stacks"
	}
	if absolute, err := filepath.Abs(root); err == nil {
		root = absolute
	}
	return &stackManager{root: filepath.Clean(root)}
}

type stackPaths struct {
	Name        string
	Dir         string
	ComposePath string
	DirExists   bool
	Exists      bool
}

func (s *stackManager) realRoot() (string, error) {
	if s == nil || strings.TrimSpace(s.root) == "" {
		return "", errors.New("stacks 目录未配置")
	}
	if err := os.MkdirAll(s.root, 0o750); err != nil {
		return "", err
	}
	resolved, err := filepath.EvalSymlinks(s.root)
	if err != nil {
		return "", err
	}
	if !filepath.IsAbs(resolved) {
		if absolute, absErr := filepath.Abs(resolved); absErr == nil {
			resolved = absolute
		}
	}
	return filepath.Clean(resolved), nil
}

func pathWithin(root, target string) bool {
	rel, err := filepath.Rel(root, target)
	if err == nil {
		if rel == "." {
			return true
		}
		if rel != ".." && !strings.HasPrefix(rel, ".."+string(os.PathSeparator)) && !filepath.IsAbs(rel) {
			return true
		}
	}
	if runtime.GOOS == "windows" {
		lowerRoot := strings.ToLower(filepath.Clean(root)) + string(os.PathSeparator)
		lowerTarget := strings.ToLower(filepath.Clean(target))
		return strings.HasPrefix(lowerTarget, lowerRoot)
	}
	return false
}

func samePath(left, right string) bool {
	if runtime.GOOS == "windows" {
		return strings.EqualFold(filepath.Clean(left), filepath.Clean(right))
	}
	return filepath.Clean(left) == filepath.Clean(right)
}

func internalPathError(message string, err error) *protocol.PanelError {
	details := map[string]any{}
	if err != nil {
		details["error"] = err.Error()
	}
	return &protocol.PanelError{Code: protocol.CodeInternal, Message: message, Details: details}
}

// resolve computes the path of <root>/<name>/compose.yaml and verifies every
// existing component stays inside the real stacks root.
func (s *stackManager) resolve(name string) (stackPaths, *protocol.PanelError) {
	paths := stackPaths{Name: name}
	if !validStackName(name) {
		return paths, protocol.BadRequest("编排名称不合法：只允许小写字母、数字、下划线和短横线")
	}
	root, err := s.realRoot()
	if err != nil {
		return paths, internalPathError("无法访问 stacks 目录", err)
	}
	dir := filepath.Join(root, name)
	paths.Dir = dir
	paths.ComposePath = filepath.Join(dir, "compose.yaml")

	info, err := os.Lstat(dir)
	switch {
	case err == nil:
		if info.Mode()&os.ModeSymlink != 0 {
			return paths, protocol.BadRequest("编排目录不能是符号链接")
		}
		if !info.IsDir() {
			return paths, protocol.BadRequest("编排路径不是目录")
		}
		resolved, evalErr := filepath.EvalSymlinks(dir)
		if evalErr != nil {
			return paths, protocol.BadRequest("无法解析编排目录")
		}
		if !samePath(resolved, dir) || !pathWithin(root, resolved) {
			return paths, protocol.BadRequest("编排目录越界")
		}
		paths.DirExists = true
	case os.IsNotExist(err):
		// A new stack: the name is already regex-validated and the parent is the
		// real stacks root, so the lexical path cannot escape.
	default:
		return paths, internalPathError("无法读取编排目录", err)
	}

	if !paths.DirExists {
		return paths, nil
	}

	fileInfo, err := os.Lstat(paths.ComposePath)
	switch {
	case err == nil:
		if fileInfo.Mode()&os.ModeSymlink != 0 {
			return paths, protocol.BadRequest("compose 文件不能是符号链接")
		}
		if fileInfo.IsDir() {
			return paths, protocol.BadRequest("compose 路径不是文件")
		}
		resolved, evalErr := filepath.EvalSymlinks(paths.ComposePath)
		if evalErr != nil {
			return paths, protocol.BadRequest("无法解析 compose 文件路径")
		}
		if !samePath(resolved, paths.ComposePath) || !pathWithin(root, resolved) {
			return paths, protocol.BadRequest("compose 文件路径越界")
		}
		paths.Exists = true
	case os.IsNotExist(err):
		// No compose file yet.
	default:
		return paths, internalPathError("无法读取 compose 文件", err)
	}
	return paths, nil
}

func (s *stackManager) readCompose(paths stackPaths) (string, *protocol.PanelError) {
	if !paths.Exists {
		return "", protocol.NotFound("编排", paths.Name)
	}
	data, err := os.ReadFile(paths.ComposePath)
	if err != nil {
		if os.IsNotExist(err) {
			return "", protocol.NotFound("编排", paths.Name)
		}
		return "", internalPathError("读取 compose 文件失败", err)
	}
	if len(data) > maxComposeBytes {
		return "", &protocol.PanelError{
			Code:    protocol.CodeBadRequest,
			Message: "compose 文件超过 1 MiB 上限",
			Details: map[string]any{"path": paths.ComposePath, "size": len(data)},
		}
	}
	return string(data), nil
}

func (s *stackManager) writeCompose(paths stackPaths, content string) *protocol.PanelError {
	targetDir := paths.Dir
	if err := os.MkdirAll(targetDir, 0o750); err != nil {
		return internalPathError("创建编排目录失败", err)
	}
	info, err := os.Lstat(targetDir)
	if err != nil {
		return internalPathError("无法读取编排目录", err)
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return protocol.BadRequest("编排目录不合法")
	}
	resolved, err := filepath.EvalSymlinks(targetDir)
	if err != nil {
		return internalPathError("无法解析编排目录", err)
	}
	if !samePath(resolved, targetDir) {
		return protocol.BadRequest("编排目录不能是符号链接")
	}
	root, err := s.realRoot()
	if err != nil {
		return internalPathError("无法访问 stacks 目录", err)
	}
	if !pathWithin(root, resolved) {
		return protocol.BadRequest("编排目录越界")
	}
	composePath := filepath.Join(resolved, "compose.yaml")
	if existing, statErr := os.Lstat(composePath); statErr == nil && existing.Mode()&os.ModeSymlink != 0 {
		return protocol.BadRequest("compose 文件不能是符号链接")
	}
	if err := writeFileAtomic(composePath, []byte(content), 0o640); err != nil {
		return internalPathError("写入 compose 文件失败", err)
	}
	return nil
}

func writeFileAtomic(path string, data []byte, mode os.FileMode) error {
	dir := filepath.Dir(path)
	temp, err := os.CreateTemp(dir, ".mpanel-compose-*.tmp")
	if err != nil {
		return err
	}
	tempName := temp.Name()
	cleanup := func() {
		_ = temp.Close()
		_ = os.Remove(tempName)
	}
	if _, err := temp.Write(data); err != nil {
		cleanup()
		return err
	}
	if err := temp.Sync(); err != nil {
		cleanup()
		return err
	}
	if err := temp.Chmod(mode); err != nil && runtime.GOOS != "windows" {
		cleanup()
		return err
	}
	if err := temp.Close(); err != nil {
		_ = os.Remove(tempName)
		return err
	}
	if err := os.Rename(tempName, path); err != nil {
		_ = os.Remove(tempName)
		return err
	}
	return nil
}

/* ------------------------------ local stacks ------------------------------ */

type localStack struct {
	Name      string
	Paths     stackPaths
	UpdatedAt time.Time
}

func (s *stackManager) list() []localStack {
	root, err := s.realRoot()
	if err != nil {
		return nil
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		return nil
	}
	stacks := make([]localStack, 0, len(entries))
	for _, entry := range entries {
		if !entry.IsDir() || entry.Type()&os.ModeSymlink != 0 {
			continue
		}
		name := entry.Name()
		if !validStackName(name) {
			continue
		}
		paths, pErr := s.resolve(name)
		if pErr != nil || !paths.Exists {
			continue
		}
		updated := time.Time{}
		if info, statErr := os.Stat(paths.ComposePath); statErr == nil {
			updated = info.ModTime().UTC()
		}
		stacks = append(stacks, localStack{Name: name, Paths: paths, UpdatedAt: updated})
	}
	sort.SliceStable(stacks, func(i, j int) bool { return stacks[i].Name < stacks[j].Name })
	return stacks
}

/* ------------------------------- summaries ------------------------------- */

func filterProjectContainers(containers []ContainerSummary, project string) []ContainerSummary {
	out := make([]ContainerSummary, 0)
	for _, container := range containers {
		if container.ComposeProject != nil && *container.ComposeProject == project {
			out = append(out, container)
		}
	}
	sortContainerSummaries(out)
	return out
}

func stackConfigFiles(group []ContainerSummary, fallback string) []string {
	files := make([]string, 0)
	for _, container := range group {
		raw := strings.TrimSpace(container.Labels[labelComposeConfigFiles])
		if raw == "" {
			continue
		}
		for _, file := range strings.Split(raw, ",") {
			file = strings.TrimSpace(file)
			if file == "" {
				continue
			}
			files = appendUnique(files, file)
		}
		if len(files) > 0 {
			break
		}
	}
	if len(files) == 0 {
		// Older compose versions may only carry the working directory label.
		for _, container := range group {
			workingDir := strings.TrimSpace(container.Labels[labelComposeWorkingDir])
			if workingDir != "" {
				files = append(files, filepath.Join(workingDir, "compose.yaml"))
				break
			}
		}
	}
	if len(files) == 0 && fallback != "" {
		files = append(files, fallback)
	}
	return files
}

func stackStatusFromContainers(group []ContainerSummary) (status string, running int) {
	running = 0
	restarting := false
	paused := false
	for _, container := range group {
		switch container.State {
		case "running":
			running++
		case "restarting":
			restarting = true
		case "paused":
			paused = true
		}
	}
	switch {
	case len(group) == 0:
		return "created", 0
	case running == len(group):
		return "running", running
	case running == 0:
		if restarting {
			return "restarting", 0
		}
		if paused {
			return "paused", 0
		}
		return "exited", 0
	default:
		return "degraded", running
	}
}

func maxContainerCreated(group []ContainerSummary) (time.Time, bool) {
	var newest time.Time
	found := false
	for _, container := range group {
		created, ok := parseDockerTime(container.Created)
		if !ok {
			continue
		}
		if !found || created.After(newest) {
			newest = created
			found = true
		}
	}
	return newest, found
}

func stackSummary(name string, group []ContainerSummary, localPath string, localUpdated time.Time, dockerKnown bool) StackSummary {
	var updatedAt *string
	updated := localUpdated
	if newest, ok := maxContainerCreated(group); ok && newest.After(updated) {
		updated = newest
	}
	if !updated.IsZero() {
		value := updated.UTC().Format(time.RFC3339)
		updatedAt = &value
	}
	status := "unknown"
	running := 0
	if dockerKnown {
		status, running = stackStatusFromContainers(group)
	} else if len(group) > 0 {
		_, running = stackStatusFromContainers(group)
	}
	return StackSummary{
		Name:           name,
		Status:         status,
		ConfigFiles:    stackConfigFiles(group, localPath),
		ContainerCount: len(group),
		RunningCount:   running,
		UpdatedAt:      updatedAt,
	}
}

/* -------------------------------- handlers -------------------------------- */

func (m *Module) handleListStacks(w http.ResponseWriter, r *http.Request) {
	limit, cursor, pErr := parsePageQuery(r.URL.Query())
	if pErr != nil {
		httpapi.Fail(w, pErr)
		return
	}
	available, reason := m.docker.check(r.Context())
	if !available {
		httpapi.OK(w, protocol.UnavailableList[StackSummary](reason))
		return
	}
	containers, pErr := m.docker.listContainers(r.Context(), true, "")
	if pErr != nil {
		httpapi.OK(w, protocol.UnavailableList[StackSummary](panelErrorReason(pErr)))
		return
	}

	groups := make(map[string][]ContainerSummary)
	for _, container := range containers {
		if container.ComposeProject == nil {
			continue
		}
		name := *container.ComposeProject
		if !validStackName(name) {
			continue
		}
		groups[name] = append(groups[name], container)
	}
	locals := make(map[string]localStack)
	for _, local := range m.stacks.list() {
		locals[local.Name] = local
	}

	names := make(map[string]bool, len(groups)+len(locals))
	for name := range groups {
		names[name] = true
	}
	for name := range locals {
		names[name] = true
	}
	stacks := make([]StackSummary, 0, len(names))
	for name := range names {
		local, hasLocal := locals[name]
		localPath := ""
		localUpdated := time.Time{}
		if hasLocal {
			localPath = local.Paths.ComposePath
			localUpdated = local.UpdatedAt
		}
		stacks = append(stacks, stackSummary(name, groups[name], localPath, localUpdated, true))
	}
	sort.SliceStable(stacks, func(i, j int) bool { return stacks[i].Name < stacks[j].Name })
	httpapi.OK(w, makeListResult(stacks, limit, cursor))
}

func (m *Module) handleGetStack(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	if !validStackName(name) {
		httpapi.Fail(w, protocol.BadRequest("编排名称不合法"))
		return
	}
	containers := []ContainerSummary{}
	dockerKnown := false
	dockerReason := ""
	available, reason := m.docker.check(r.Context())
	if available {
		all, pErr := m.docker.listContainers(r.Context(), true, "")
		if pErr != nil {
			dockerReason = panelErrorReason(pErr)
		} else {
			containers = all
			dockerKnown = true
		}
	} else {
		dockerReason = reason
	}
	detail, pErr := m.buildStackDetail(name, containers, dockerKnown, dockerReason)
	if pErr != nil {
		httpapi.Fail(w, pErr)
		return
	}
	httpapi.OK(w, detail)
}

func (m *Module) buildStackDetail(name string, containers []ContainerSummary, dockerKnown bool, dockerReason string) (StackDetail, *protocol.PanelError) {
	paths, pErr := m.stacks.resolve(name)
	if pErr != nil {
		return StackDetail{}, pErr
	}
	localYAML := ""
	localUpdated := time.Time{}
	if paths.Exists {
		content, pErr := m.stacks.readCompose(paths)
		if pErr != nil {
			return StackDetail{}, pErr
		}
		localYAML = content
		if info, err := os.Stat(paths.ComposePath); err == nil {
			localUpdated = info.ModTime().UTC()
		}
	}
	group := filterProjectContainers(containers, name)
	if !paths.Exists && len(group) == 0 {
		if !dockerKnown {
			return StackDetail{}, m.docker.unavailable(dockerReason)
		}
		return StackDetail{}, protocol.NotFound("编排", name)
	}
	localPath := ""
	if paths.Exists {
		localPath = paths.ComposePath
	}
	summary := stackSummary(name, group, localPath, localUpdated, dockerKnown)
	composePath := localPath
	if composePath == "" && len(summary.ConfigFiles) > 0 {
		composePath = summary.ConfigFiles[0]
	}
	return StackDetail{
		StackSummary: summary,
		ComposePath:  composePath,
		ComposeYAML:  localYAML,
		Containers:   group,
	}, nil
}

func (m *Module) handleCreateStack(w http.ResponseWriter, r *http.Request) {
	var body stackCreateInput
	if !httpapi.DecodeJSON(w, r, &body) {
		return
	}
	if !validStackName(body.Name) {
		httpapi.Fail(w, protocol.BadRequest("编排名称不合法：只允许小写字母、数字、下划线和短横线"))
		return
	}
	if pErr := validateComposeBody(body.ComposeYAML); pErr != nil {
		httpapi.Fail(w, pErr)
		return
	}
	paths, pErr := m.stacks.resolve(body.Name)
	if pErr != nil {
		httpapi.Fail(w, pErr)
		return
	}
	if paths.Exists {
		httpapi.Fail(w, protocol.Conflict("编排已存在"))
		return
	}
	if pErr := m.docker.ensure(r.Context()); pErr != nil {
		httpapi.Fail(w, pErr)
		return
	}
	createdDir := !paths.DirExists

	m.opMu.Lock()
	defer m.opMu.Unlock()

	paths, pErr = m.prepareStackDir(body.Name)
	if pErr != nil {
		httpapi.Fail(w, pErr)
		return
	}
	cleanup := func() {
		if createdDir {
			_ = os.Remove(paths.ComposePath)
			_ = os.Remove(paths.Dir)
		}
	}
	if pErr := m.validateComposeYAML(r.Context(), body.Name, paths.Dir, body.ComposeYAML); pErr != nil {
		cleanup()
		httpapi.Fail(w, pErr)
		return
	}
	if pErr := m.stacks.writeCompose(paths, body.ComposeYAML); pErr != nil {
		cleanup()
		httpapi.Fail(w, pErr)
		return
	}
	detail := m.detailAfterWrite(r.Context(), body.Name)
	httpapi.Created(w, detail)
}

func (m *Module) handleUpdateStack(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	if !validStackName(name) {
		httpapi.Fail(w, protocol.BadRequest("编排名称不合法"))
		return
	}
	var body stackUpdateInput
	if !httpapi.DecodeJSON(w, r, &body) {
		return
	}
	if pErr := validateComposeBody(body.ComposeYAML); pErr != nil {
		httpapi.Fail(w, pErr)
		return
	}
	paths, pErr := m.stacks.resolve(name)
	if pErr != nil {
		httpapi.Fail(w, pErr)
		return
	}
	if !paths.Exists {
		httpapi.Fail(w, protocol.NotFound("编排", name))
		return
	}
	if pErr := m.docker.ensure(r.Context()); pErr != nil {
		httpapi.Fail(w, pErr)
		return
	}

	m.opMu.Lock()
	defer m.opMu.Unlock()

	if pErr := m.validateComposeYAML(r.Context(), name, paths.Dir, body.ComposeYAML); pErr != nil {
		httpapi.Fail(w, pErr)
		return
	}
	if pErr := m.stacks.writeCompose(paths, body.ComposeYAML); pErr != nil {
		httpapi.Fail(w, pErr)
		return
	}
	detail := m.detailAfterWrite(r.Context(), name)
	httpapi.OK(w, detail)
}

func validateComposeBody(content string) *protocol.PanelError {
	if strings.TrimSpace(content) == "" {
		return protocol.BadRequest("composeYaml 不能为空")
	}
	if len(content) > maxComposeBytes {
		return protocol.BadRequest("composeYaml 超过 1 MiB 上限")
	}
	if strings.ContainsRune(content, 0) {
		return protocol.BadRequest("composeYaml 不能包含 NUL 字符")
	}
	return nil
}

func (m *Module) prepareStackDir(name string) (stackPaths, *protocol.PanelError) {
	paths, pErr := m.stacks.resolve(name)
	if pErr != nil {
		return paths, pErr
	}
	if paths.DirExists {
		return paths, nil
	}
	root, err := m.stacks.realRoot()
	if err != nil {
		return paths, internalPathError("无法访问 stacks 目录", err)
	}
	dir := filepath.Join(root, name)
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return paths, internalPathError("创建编排目录失败", err)
	}
	paths, pErr = m.stacks.resolve(name)
	if pErr != nil {
		_ = os.Remove(dir)
		return paths, pErr
	}
	if !paths.DirExists {
		_ = os.Remove(dir)
		return paths, internalPathError("编排目录创建失败", nil)
	}
	return paths, nil
}

// validateComposeYAML writes the candidate YAML to a temporary file inside the
// final stack directory and runs docker compose config. Relative paths in the
// compose file therefore resolve exactly as they will after saving.
func (m *Module) validateComposeYAML(ctx context.Context, name, dir, content string) *protocol.PanelError {
	temp, err := os.CreateTemp(dir, ".mpanel-validate-*.yaml")
	if err != nil {
		return internalPathError("创建 compose 校验文件失败", err)
	}
	tempName := temp.Name()
	defer func() {
		_ = temp.Close()
		_ = os.Remove(tempName)
	}()
	if _, err := temp.WriteString(content); err != nil {
		return internalPathError("写入 compose 校验文件失败", err)
	}
	if err := temp.Close(); err != nil {
		return internalPathError("写入 compose 校验文件失败", err)
	}
	res, err := m.docker.run(ctx, 60*time.Second,
		"compose", "-p", name, "-f", tempName, "config")
	if err != nil {
		return m.docker.unavailable("无法执行 docker compose：" + err.Error())
	}
	if res.Code != 0 {
		if isComposeMissing(res) {
			return composeUnavailable(res)
		}
		if isDockerDaemonUnavailable(res) {
			return m.docker.unavailable(firstNonEmptyLine(res.Stderr, res.Stdout))
		}
		output := strings.TrimSpace(res.Stdout)
		if output == "" {
			output = strings.TrimSpace(res.Stderr)
		}
		if output == "" {
			output = "docker compose config 退出码 " + strconv.Itoa(res.Code)
		}
		return &protocol.PanelError{
			Code:    protocol.CodeBadRequest,
			Message: "compose 配置校验失败",
			Details: map[string]any{"output": truncateTextString(output, dockerOutputDetails)},
			Hint:    "请修正 compose YAML 后重试（可先在本地执行 docker compose config 校验）。",
		}
	}
	return nil
}

func (m *Module) detailAfterWrite(ctx context.Context, name string) StackDetail {
	containers := []ContainerSummary{}
	dockerKnown := false
	dockerReason := ""
	if available, reason := m.docker.check(ctx); available {
		if all, pErr := m.docker.listContainers(ctx, true, ""); pErr == nil {
			containers = all
			dockerKnown = true
		} else {
			dockerReason = panelErrorReason(pErr)
		}
	} else {
		dockerReason = reason
	}
	if detail, pErr := m.buildStackDetail(name, containers, dockerKnown, dockerReason); pErr == nil {
		return detail
	}
	// The file was just written; this is only a defensive fallback.
	return StackDetail{StackSummary: StackSummary{Name: name, ConfigFiles: []string{}, Status: "unknown"}, Containers: []ContainerSummary{}}
}

func (m *Module) handleDeleteStack(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	if !validStackName(name) {
		httpapi.Fail(w, protocol.BadRequest("编排名称不合法"))
		return
	}
	force, ok := parseQueryBool(r.URL.Query().Get("force"), false)
	if !ok {
		httpapi.Fail(w, protocol.BadRequest("force 必须是布尔值"))
		return
	}
	paths, pErr := m.stacks.resolve(name)
	if pErr != nil {
		httpapi.Fail(w, pErr)
		return
	}
	if !paths.Exists {
		httpapi.Fail(w, protocol.NotFound("编排", name))
		return
	}

	available, reason := m.docker.check(r.Context())
	if !available {
		// §2.4: writes on /stacks are UNAVAILABLE without docker CLI/daemon.
		httpapi.Fail(w, m.docker.unavailable(reason))
		return
	}
	containers, pErr := m.docker.listContainers(r.Context(), true, "")
	if pErr != nil {
		httpapi.Fail(w, pErr)
		return
	}
	group := filterProjectContainers(containers, name)
	running := 0
	for _, container := range group {
		if isActiveContainerState(container.State) {
			running++
		}
	}
	if running > 0 && !force {
		httpapi.Fail(w, &protocol.PanelError{
			Code:    protocol.CodeConflict,
			Message: "编排仍在运行，不能直接删除",
			Details: map[string]any{"running": running},
			Hint:    "先执行停止（docker compose down），或使用 force=true 仅删除 compose 文件（不会停止容器）。",
		})
		return
	}

	m.opMu.Lock()
	defer m.opMu.Unlock()
	current, pErr := m.stacks.resolve(name)
	if pErr != nil {
		httpapi.Fail(w, pErr)
		return
	}
	if !current.Exists {
		httpapi.Fail(w, protocol.NotFound("编排", name))
		return
	}
	paths = current
	if err := os.Remove(paths.ComposePath); err != nil && !os.IsNotExist(err) {
		httpapi.Fail(w, internalPathError("删除 compose 文件失败", err))
		return
	}
	// Remove the directory only when it is empty; other user files are kept.
	_ = os.Remove(paths.Dir)
	httpapi.OK(w, stackRemoveResult{Deleted: true, Name: name})
}

/* ------------------------------ stack actions ----------------------------- */

func (m *Module) handleStackAction(action string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		name := r.PathValue("name")
		if !validStackName(name) {
			httpapi.Fail(w, protocol.BadRequest("编排名称不合法"))
			return
		}
		var body stackActionInput
		if !httpapi.DecodeJSON(w, r, &body) {
			return
		}
		paths, pErr := m.stacks.resolve(name)
		if pErr != nil {
			httpapi.Fail(w, pErr)
			return
		}
		if !paths.Exists {
			httpapi.Fail(w, protocol.NotFound("编排", name))
			return
		}
		if pErr := m.docker.ensure(r.Context()); pErr != nil {
			httpapi.Fail(w, pErr)
			return
		}

		args := []string{"compose", "-p", name, "-f", paths.ComposePath}
		timeout := 300 * time.Second
		switch action {
		case "up":
			args = append(args, "up", "-d")
			if body.Build {
				args = append(args, "--build")
			}
			if body.ForceRecreate {
				args = append(args, "--force-recreate")
			}
			timeout = 620 * time.Second
		case "down":
			args = append(args, "down")
			if body.RemoveVolumes {
				args = append(args, "--volumes")
			}
			if body.RemoveImages {
				args = append(args, "--rmi", "all")
			}
		case "restart":
			args = append(args, "restart")
		case "pull":
			args = append(args, "pull")
			timeout = 620 * time.Second
		default:
			httpapi.Fail(w, protocol.BadRequest("不支持的编排操作"))
			return
		}

		m.opMu.Lock()
		res, err := m.docker.run(r.Context(), timeout, args...)
		m.opMu.Unlock()
		if err != nil {
			httpapi.Fail(w, m.docker.unavailable("无法执行 docker compose "+action+"："+err.Error()))
			return
		}
		if res.Code != 0 {
			if isComposeMissing(res) {
				httpapi.Fail(w, composeUnavailable(res))
				return
			}
			httpapi.Fail(w, dockerCommandFailed("compose "+action, res))
			return
		}
		output := strings.TrimSpace(res.Stdout + "\n" + res.Stderr)
		output, _ = truncateText(output, maxLogBytes)
		httpapi.OK(w, stackActionResult{OK: true, Output: output})
	}
}

/* -------------------------------- stack logs ------------------------------ */

func (m *Module) handleStackLogs(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	if !validStackName(name) {
		httpapi.Fail(w, protocol.BadRequest("编排名称不合法"))
		return
	}
	query := r.URL.Query()
	tail := 200
	if raw := strings.TrimSpace(query.Get("tail")); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 0 || parsed > maxTailLines {
			httpapi.Fail(w, protocol.BadRequest("tail 必须是 0.."+strconv.Itoa(maxTailLines)+" 的整数"))
			return
		}
		tail = parsed
	}
	if pErr := m.docker.ensure(r.Context()); pErr != nil {
		httpapi.Fail(w, pErr)
		return
	}
	containers, pErr := m.docker.listContainers(r.Context(), true, "")
	if pErr != nil {
		httpapi.Fail(w, pErr)
		return
	}
	paths, pErr := m.stacks.resolve(name)
	if pErr != nil {
		httpapi.Fail(w, pErr)
		return
	}
	group := filterProjectContainers(containers, name)
	if !paths.Exists && len(group) == 0 {
		httpapi.Fail(w, protocol.NotFound("编排", name))
		return
	}
	if len(group) == 0 {
		httpapi.OK(w, ContainerLogsResult{Logs: "", Truncated: false})
		return
	}
	truncated := false
	if len(group) > 64 {
		group = group[:64]
		truncated = true
	}
	var builder strings.Builder
	for _, container := range group {
		if builder.Len() >= maxLogBytes {
			truncated = true
			break
		}
		service := containerServiceName(container)
		res, err := m.docker.run(r.Context(), 20*time.Second,
			"logs", "--tail", strconv.Itoa(tail), container.ID)
		if err != nil {
			httpapi.Fail(w, m.docker.unavailable("无法执行 docker logs："+err.Error()))
			return
		}
		if res.Code != 0 {
			reason := firstNonEmptyLine(res.Stderr, res.Stdout)
			if reason == "" {
				reason = "docker logs 退出码 " + strconv.Itoa(res.Code)
			}
			builder.WriteString("[" + service + "] (日志读取失败: " + reason + ")\n")
			continue
		}
		for _, stream := range []string{res.Stdout, res.Stderr} {
			if stream == "" {
				continue
			}
			for _, line := range strings.Split(strings.TrimRight(stream, "\n"), "\n") {
				builder.WriteString("[" + service + "] " + line + "\n")
				if builder.Len() >= maxLogBytes {
					truncated = true
					break
				}
			}
			if truncated {
				break
			}
		}
		if truncated {
			break
		}
	}
	logs, cut := truncateText(builder.String(), maxLogBytes)
	httpapi.OK(w, ContainerLogsResult{Logs: logs, Truncated: truncated || cut})
}

func isActiveContainerState(state string) bool {
	switch state {
	case "running", "restarting", "paused":
		return true
	default:
		return false
	}
}

func containerServiceName(container ContainerSummary) string {
	if container.ComposeService != nil && strings.TrimSpace(*container.ComposeService) != "" {
		return *container.ComposeService
	}
	if len(container.Names) > 0 && container.Names[0] != "" {
		return container.Names[0]
	}
	if len(container.ID) > 12 {
		return container.ID[:12]
	}
	return container.ID
}
