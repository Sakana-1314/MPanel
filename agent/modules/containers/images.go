package containers

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/sakana-1314/mpanel/internal/httpapi"
	"github.com/sakana-1314/mpanel/internal/protocol"
)

/* --------------------------------- images -------------------------------- */

func (m *Module) handleListImages(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	all, ok := parseQueryBool(query.Get("all"), false)
	if !ok {
		httpapi.Fail(w, protocol.BadRequest("all 必须是布尔值"))
		return
	}
	dangling, ok := parseQueryBool(query.Get("dangling"), false)
	if !ok {
		httpapi.Fail(w, protocol.BadRequest("dangling 必须是布尔值"))
		return
	}
	limit, cursor, pErr := parsePageQuery(query)
	if pErr != nil {
		httpapi.Fail(w, pErr)
		return
	}
	available, reason := m.docker.check(r.Context())
	if !available {
		httpapi.OK(w, protocol.UnavailableList[ImageSummary](reason))
		return
	}
	images, pErr := m.docker.listImages(r.Context(), all, dangling)
	if pErr != nil {
		httpapi.OK(w, protocol.UnavailableList[ImageSummary](panelErrorReason(pErr)))
		return
	}
	needle := strings.ToLower(strings.TrimSpace(query.Get("q")))
	if needle != "" {
		filtered := images[:0]
		for _, image := range images {
			if imageMatches(image, needle) {
				filtered = append(filtered, image)
			}
		}
		images = filtered
	}
	httpapi.OK(w, makeListResult(images, limit, cursor))
}

func imageMatches(image ImageSummary, needle string) bool {
	if strings.Contains(strings.ToLower(image.ID), needle) {
		return true
	}
	for _, tag := range image.RepoTags {
		if strings.Contains(strings.ToLower(tag), needle) {
			return true
		}
	}
	for _, digest := range image.RepoDigests {
		if strings.Contains(strings.ToLower(digest), needle) {
			return true
		}
	}
	return false
}

// psImage mirrors docker images --format json. Different Docker releases emit
// slightly different fields, so all of them are optional.
type psImage struct {
	ID           string `json:"ID"`
	Repository   string `json:"Repository"`
	Tag          string `json:"Tag"`
	Digest       string `json:"Digest"`
	CreatedAt    string `json:"CreatedAt"`
	CreatedSince string `json:"CreatedSince"`
	Size         string `json:"Size"`
	SharedSize   string `json:"SharedSize"`
	UniqueSize   string `json:"UniqueSize"`
	VirtualSize  string `json:"VirtualSize"`
	Containers   string `json:"Containers"`
	Labels       string `json:"Labels"`
}

func parseImageSummaries(stdout string) []ImageSummary {
	type aggregate struct {
		summary    ImageSummary
		created    time.Time
		hasCreated bool
	}
	byID := make(map[string]*aggregate)
	order := make([]string, 0)

	scanJSONLines(stdout, func(line []byte) {
		var raw psImage
		if err := json.Unmarshal(line, &raw); err != nil {
			return
		}
		id := strings.TrimSpace(raw.ID)
		if id == "" {
			return
		}
		entry := byID[id]
		if entry == nil {
			entry = &aggregate{summary: ImageSummary{
				ID:          id,
				RepoTags:    []string{},
				RepoDigests: []string{},
				Labels:      map[string]string{},
			}}
			byID[id] = entry
			order = append(order, id)
		}
		repo := strings.TrimSpace(raw.Repository)
		tag := strings.TrimSpace(raw.Tag)
		digest := strings.TrimSpace(raw.Digest)
		validRepo := repo != "" && repo != "<none>"
		if validRepo && tag != "" && tag != "<none>" {
			entry.summary.RepoTags = appendUnique(entry.summary.RepoTags, repo+":"+tag)
		}
		if validRepo && digest != "" && digest != "<none>" {
			entry.summary.RepoDigests = appendUnique(entry.summary.RepoDigests, repo+"@"+digest)
		}
		if size := parseDockerSize(raw.Size); size > entry.summary.SizeBytes {
			entry.summary.SizeBytes = size
		}
		if entry.summary.CreatedAt == "" && strings.TrimSpace(raw.CreatedAt) != "" {
			entry.summary.CreatedAt = normalizeDockerTime(raw.CreatedAt)
		}
		if parsed, ok := parseDockerTime(raw.CreatedAt); ok && (!entry.hasCreated || parsed.After(entry.created)) {
			entry.created = parsed
			entry.hasCreated = true
		}
		if raw.Labels != "" {
			for key, value := range parseLabelsString(raw.Labels) {
				entry.summary.Labels[key] = value
			}
		}
	})

	images := make([]ImageSummary, 0, len(order))
	for _, id := range order {
		entry := byID[id]
		if entry.summary.RepoTags == nil {
			entry.summary.RepoTags = []string{}
		}
		if entry.summary.RepoDigests == nil {
			entry.summary.RepoDigests = []string{}
		}
		if entry.summary.Labels == nil {
			entry.summary.Labels = map[string]string{}
		}
		entry.summary.Dangling = len(entry.summary.RepoTags) == 0
		images = append(images, entry.summary)
	}
	sort.SliceStable(images, func(i, j int) bool {
		left, leftOK := parseDockerTime(images[i].CreatedAt)
		right, rightOK := parseDockerTime(images[j].CreatedAt)
		if leftOK && rightOK && !left.Equal(right) {
			return left.After(right)
		}
		if leftOK != rightOK {
			return leftOK
		}
		return images[i].ID < images[j].ID
	})
	return images
}

func appendUnique(values []string, value string) []string {
	for _, existing := range values {
		if existing == value {
			return values
		}
	}
	return append(values, value)
}

func (d *dockerClient) listImages(ctx context.Context, all, dangling bool) ([]ImageSummary, *protocol.PanelError) {
	args := []string{"images", "--no-trunc", "--format", "json"}
	if all {
		args = append(args, "--all")
	}
	if dangling {
		args = append(args, "--filter", "dangling=true")
	}
	res, err := d.run(ctx, 60*time.Second, args...)
	if err != nil {
		return nil, d.unavailable("无法执行 docker images：" + err.Error())
	}
	if res.Code != 0 {
		reason := firstNonEmptyLine(res.Stderr, res.Stdout)
		if reason == "" {
			reason = "docker images 退出码 " + strconv.Itoa(res.Code)
		}
		return nil, &protocol.PanelError{
			Code:    protocol.CodeUnavailable,
			Message: "无法读取镜像列表",
			Details: map[string]any{"reason": reason},
			Hint:    dockerInstallHint,
		}
	}
	return parseImageSummaries(res.Stdout), nil
}

type inspectImage struct {
	ID          string            `json:"Id"`
	RepoTags    []string          `json:"RepoTags"`
	RepoDigests []string          `json:"RepoDigests"`
	Created     string            `json:"Created"`
	Size        int64             `json:"Size"`
	Labels      map[string]string `json:"Labels"`
	Config      struct {
		Labels map[string]string `json:"Labels"`
	} `json:"Config"`
}

func (image inspectImage) summary() ImageSummary {
	tags := make([]string, 0, len(image.RepoTags))
	for _, tag := range image.RepoTags {
		tag = strings.TrimSpace(tag)
		if tag == "" || tag == "<none>:<none>" {
			continue
		}
		tags = append(tags, tag)
	}
	digests := make([]string, 0, len(image.RepoDigests))
	for _, digest := range image.RepoDigests {
		digest = strings.TrimSpace(digest)
		if digest == "" || strings.HasPrefix(digest, "<none>") {
			continue
		}
		digests = append(digests, digest)
	}
	labels := image.Config.Labels
	if labels == nil {
		labels = image.Labels
	}
	if labels == nil {
		labels = map[string]string{}
	}
	return ImageSummary{
		ID:          image.ID,
		RepoTags:    tags,
		RepoDigests: digests,
		SizeBytes:   image.Size,
		CreatedAt:   normalizeDockerTime(image.Created),
		Labels:      copyLabels(labels),
		Dangling:    len(tags) == 0,
	}
}

func parseInspectImages(data string) ([]inspectImage, error) {
	data = strings.TrimSpace(data)
	if data == "" {
		return nil, errors.New("inspect 输出为空")
	}
	var list []inspectImage
	if err := json.Unmarshal([]byte(data), &list); err == nil {
		return list, nil
	}
	var single inspectImage
	if err := json.Unmarshal([]byte(data), &single); err == nil && single.ID != "" {
		return []inspectImage{single}, nil
	}
	return nil, errors.New("无法解析 inspect 输出")
}

func (d *dockerClient) inspectImage(ctx context.Context, reference string) (ImageSummary, *protocol.PanelError) {
	res, err := d.run(ctx, 60*time.Second, "image", "inspect", reference)
	if err != nil {
		return ImageSummary{}, d.unavailable("无法执行 docker image inspect：" + err.Error())
	}
	if res.Code != 0 {
		if isNoSuchImageOutput(res) {
			return ImageSummary{}, protocol.NotFound("镜像", reference)
		}
		return ImageSummary{}, dockerCommandFailed("image inspect", res)
	}
	images, err := parseInspectImages(res.Stdout)
	if err != nil {
		return ImageSummary{}, &protocol.PanelError{
			Code:    protocol.CodeUpstreamError,
			Message: "无法解析 docker image inspect 输出",
			Details: map[string]any{"error": err.Error()},
		}
	}
	if len(images) == 0 {
		return ImageSummary{}, protocol.NotFound("镜像", reference)
	}
	return images[0].summary(), nil
}

type imagePullInput struct {
	Reference string `json:"reference"`
}

func (m *Module) handlePullImage(w http.ResponseWriter, r *http.Request) {
	var body imagePullInput
	if !httpapi.DecodeJSON(w, r, &body) {
		return
	}
	if !validImageRef(body.Reference) {
		httpapi.Fail(w, protocol.BadRequest("reference 不合法：不能为空、不能包含空白且不能以 - 开头"))
		return
	}
	if pErr := m.docker.ensure(r.Context()); pErr != nil {
		httpapi.Fail(w, pErr)
		return
	}
	res, err := m.docker.run(r.Context(), 620*time.Second, "pull", body.Reference)
	if err != nil {
		httpapi.Fail(w, m.docker.unavailable("无法执行 docker pull："+err.Error()))
		return
	}
	if res.Code != 0 {
		httpapi.Fail(w, dockerCommandFailed("pull", res))
		return
	}
	image, pErr := m.docker.inspectImage(r.Context(), body.Reference)
	if pErr != nil {
		// Pull succeeded but inspect failed: still return a usable summary rather
		// than reporting a failed pull.
		image = ImageSummary{
			ID:          "",
			RepoTags:    []string{body.Reference},
			RepoDigests: []string{},
			SizeBytes:   0,
			CreatedAt:   time.Now().UTC().Format(time.RFC3339),
			Labels:      map[string]string{},
			Dangling:    false,
		}
	}
	httpapi.OK(w, ImagePullResult{Image: image})
}

type imageRemoveResult struct {
	Deleted bool   `json:"deleted"`
	ID      string `json:"id"`
}

func (m *Module) handleRemoveImage(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !validImageRef(id) {
		httpapi.Fail(w, protocol.BadRequest("镜像 id 不合法"))
		return
	}
	force, ok := parseQueryBool(r.URL.Query().Get("force"), false)
	if !ok {
		httpapi.Fail(w, protocol.BadRequest("force 必须是布尔值"))
		return
	}
	if pErr := m.docker.ensure(r.Context()); pErr != nil {
		httpapi.Fail(w, pErr)
		return
	}
	args := []string{"rmi"}
	if force {
		args = append(args, "--force")
	}
	args = append(args, id)
	res, err := m.docker.run(r.Context(), 120*time.Second, args...)
	if err != nil {
		httpapi.Fail(w, m.docker.unavailable("无法执行 docker rmi："+err.Error()))
		return
	}
	if res.Code != 0 {
		if isNoSuchImageOutput(res) {
			httpapi.Fail(w, protocol.NotFound("镜像", id))
			return
		}
		pErr := dockerCommandFailed("rmi", res)
		text := strings.ToLower(res.Stderr + "\n" + res.Stdout)
		if strings.Contains(text, "image is being used") || strings.Contains(text, "in use") ||
			strings.Contains(text, "conflict") {
			pErr.Hint = "镜像仍被容器引用；可先删除相关容器，或在确认后使用 force=true。"
		}
		httpapi.Fail(w, pErr)
		return
	}
	httpapi.OK(w, imageRemoveResult{Deleted: true, ID: id})
}

type imagePruneInput struct {
	DanglingOnly *bool `json:"danglingOnly"`
}

func (m *Module) handlePruneImages(w http.ResponseWriter, r *http.Request) {
	var body imagePruneInput
	if !httpapi.DecodeJSON(w, r, &body) {
		return
	}
	danglingOnly := true
	if body.DanglingOnly != nil {
		danglingOnly = *body.DanglingOnly
	}
	if pErr := m.docker.ensure(r.Context()); pErr != nil {
		httpapi.Fail(w, pErr)
		return
	}
	args := []string{"image", "prune", "--force"}
	if !danglingOnly {
		args = append(args, "--all")
	}
	res, err := m.docker.run(r.Context(), 300*time.Second, args...)
	if err != nil {
		httpapi.Fail(w, m.docker.unavailable("无法执行 docker image prune："+err.Error()))
		return
	}
	if res.Code != 0 {
		httpapi.Fail(w, dockerCommandFailed("image prune", res))
		return
	}
	deleted := 0
	for _, line := range strings.Split(res.Stdout, "\n") {
		if strings.HasPrefix(strings.ToLower(strings.TrimSpace(line)), "deleted:") {
			deleted++
		}
	}
	reclaimed := int64(0)
	output := res.Stdout + "\n" + res.Stderr
	lower := strings.ToLower(output)
	if idx := strings.LastIndex(lower, "total reclaimed space:"); idx >= 0 {
		rest := strings.TrimSpace(output[idx+len("total reclaimed space:"):])
		if newline := strings.IndexByte(rest, '\n'); newline >= 0 {
			rest = rest[:newline]
		}
		reclaimed = parseDockerSize(rest)
	}
	httpapi.OK(w, ImagePruneResult{Deleted: deleted, ReclaimedBytes: reclaimed})
}
