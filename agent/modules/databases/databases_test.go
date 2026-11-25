package databases

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/sakana-1314/mpanel/agent"
	"github.com/sakana-1314/mpanel/internal/auth"
	"github.com/sakana-1314/mpanel/internal/config"
)

/* ------------------------------- test harness ---------------------------- */

type fakeRunner struct{}

func (f *fakeRunner) Run(ctx context.Context, name string, args ...string) (agent.Result, error) {
	return f.RunTimeout(ctx, time.Second, name, args...)
}

func (f *fakeRunner) RunTimeout(ctx context.Context, timeout time.Duration, name string, args ...string) (agent.Result, error) {
	return agent.Result{Stdout: "pg_dump (PostgreSQL) 16.3\n"}, nil
}

func (f *fakeRunner) Stream(ctx context.Context, name string, args []string, onLine func(string)) (agent.Result, error) {
	return agent.Result{}, nil
}

type failingRunner struct{}

func (f *failingRunner) Run(ctx context.Context, name string, args ...string) (agent.Result, error) {
	return f.RunTimeout(ctx, time.Second, name, args...)
}

func (f *failingRunner) RunTimeout(ctx context.Context, timeout time.Duration, name string, args ...string) (agent.Result, error) {
	return agent.Result{}, errors.New("executable file not found in $PATH")
}

func (f *failingRunner) Stream(ctx context.Context, name string, args []string, onLine func(string)) (agent.Result, error) {
	return agent.Result{}, errors.New("executable file not found in $PATH")
}

// recordingRunner fakes pg_dump/pg_restore and writes the requested backup
// file, so the whole asynchronous job pipeline can be exercised.
type recordingRunner struct {
	mu    sync.Mutex
	calls []string
	data  []byte
}

func (r *recordingRunner) Run(ctx context.Context, name string, args ...string) (agent.Result, error) {
	return r.RunTimeout(ctx, time.Second, name, args...)
}

func (r *recordingRunner) RunTimeout(ctx context.Context, timeout time.Duration, name string, args ...string) (agent.Result, error) {
	r.mu.Lock()
	r.calls = append(r.calls, name+" "+strings.Join(args, " "))
	r.mu.Unlock()
	for _, arg := range args {
		if strings.HasPrefix(arg, "--file=") {
			path := strings.TrimPrefix(arg, "--file=")
			if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
				return agent.Result{}, err
			}
			if err := os.WriteFile(path, r.data, 0o640); err != nil {
				return agent.Result{}, err
			}
		}
	}
	return agent.Result{}, nil
}

func (r *recordingRunner) Stream(ctx context.Context, name string, args []string, onLine func(string)) (agent.Result, error) {
	return agent.Result{}, nil
}

func (r *recordingRunner) snapshot() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string{}, r.calls...)
}

func newTestModule(t *testing.T, runner agent.Runner) (*Module, *http.ServeMux, string) {
	t.Helper()
	return newTestModuleAt(t, t.TempDir(), runner)
}

func newTestModuleAt(t *testing.T, dir string, runner agent.Runner) (*Module, *http.ServeMux, string) {
	t.Helper()
	if runner == nil {
		runner = &fakeRunner{}
	}
	cfg := &config.Agent{Agent: config.AgentSystem{
		DataDir:   dir,
		PGDumpBin: "pg_dump",
		PSQLBin:   "psql",
	}}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	mux := http.NewServeMux()
	module := New()
	err := module.Register(&agent.Context{
		Mux:     mux,
		Cfg:     cfg,
		Runner:  runner,
		Logger:  logger,
		Started: time.Now(),
		Version: "test",
	})
	if err != nil {
		t.Fatalf("Register: %v", err)
	}
	return module, mux, dir
}

type testEnvelope struct {
	OK    bool            `json:"ok"`
	Data  json.RawMessage `json:"data"`
	Error *testAPIError   `json:"error"`
}

type testAPIError struct {
	Code    string         `json:"code"`
	Message string         `json:"message"`
	Details map[string]any `json:"details"`
}

func doJSON(t *testing.T, mux *http.ServeMux, method, path string, body any) (int, testEnvelope, string) {
	t.Helper()
	var reader io.Reader
	if body != nil {
		payload, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("marshal body: %v", err)
		}
		reader = bytes.NewReader(payload)
	}
	request := httptest.NewRequest(method, "http://127.0.0.1"+path, reader)
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, request)
	raw := recorder.Body.String()
	var envelope testEnvelope
	if strings.TrimSpace(raw) != "" {
		if err := json.Unmarshal([]byte(raw), &envelope); err != nil {
			t.Fatalf("decode envelope %q: %v", raw, err)
		}
	}
	return recorder.Code, envelope, raw
}

func decodeData[T any](t *testing.T, envelope testEnvelope) T {
	t.Helper()
	var value T
	if err := json.Unmarshal(envelope.Data, &value); err != nil {
		t.Fatalf("decode data %q: %v", string(envelope.Data), err)
	}
	return value
}

func mustCreateProfile(t *testing.T, mux *http.ServeMux, input DatabaseProfileCreateInput) DatabaseProfile {
	t.Helper()
	status, envelope, raw := doJSON(t, mux, http.MethodPost, "/api/v1/databases/profiles", input)
	if status != http.StatusCreated {
		t.Fatalf("create profile status = %d, body = %s", status, raw)
	}
	return decodeData[DatabaseProfile](t, envelope)
}

func doRaw(t *testing.T, mux *http.ServeMux, method, path string) (int, string, http.Header) {
	t.Helper()
	request := httptest.NewRequest(method, "http://127.0.0.1"+path, nil)
	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, request)
	return recorder.Code, recorder.Body.String(), recorder.Header()
}

func waitJob(t *testing.T, mux *http.ServeMux, id string) DatabaseJob {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		status, envelope, raw := doJSON(t, mux, http.MethodGet, "/api/v1/databases/jobs/"+id, nil)
		if status != http.StatusOK {
			t.Fatalf("get job status = %d, body = %s", status, raw)
		}
		job := decodeData[DatabaseJob](t, envelope)
		if job.Status == jobSuccess || job.Status == jobFailed {
			return job
		}
		if time.Now().After(deadline) {
			t.Fatalf("job %s did not finish, last = %+v", id, job)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func postgresInput(name, password string) DatabaseProfileCreateInput {
	return DatabaseProfileCreateInput{
		Name:     name,
		Kind:     kindPostgres,
		Host:     "127.0.0.1",
		Username: strPtr("app"),
		Password: &password,
		Database: strPtr("appdb"),
	}
}

/* ---------------------------------- tests -------------------------------- */

func TestProfilePasswordEncryptionAndMasking(t *testing.T) {
	_, mux, dir := newTestModule(t, nil)
	const secret = "s3cret-p@ss:word"

	profile := mustCreateProfile(t, mux, postgresInput("prod-pg", secret))
	if !profile.HasPassword {
		t.Fatal("created profile must report hasPassword=true")
	}

	// The plaintext must not appear in databases.json, only ciphertext.
	rawFile, err := os.ReadFile(filepath.Join(dir, "databases.json"))
	if err != nil {
		t.Fatalf("read databases.json: %v", err)
	}
	if bytes.Contains(rawFile, []byte(secret)) {
		t.Fatal("databases.json contains the plaintext password")
	}
	var file profilesFile
	if err := json.Unmarshal(rawFile, &file); err != nil {
		t.Fatalf("decode databases.json: %v", err)
	}
	if len(file.Profiles) != 1 {
		t.Fatalf("profiles on disk = %d, want 1", len(file.Profiles))
	}
	if file.Profiles[0].PasswordEnc == "" {
		t.Fatal("passwordEnc is empty on disk")
	}

	key, err := os.ReadFile(filepath.Join(dir, "secrets.key"))
	if err != nil {
		t.Fatalf("read secrets.key: %v", err)
	}
	if len(key) != 32 {
		t.Fatalf("secrets.key length = %d, want 32", len(key))
	}
	if runtime.GOOS != "windows" {
		info, err := os.Stat(filepath.Join(dir, "secrets.key"))
		if err != nil {
			t.Fatalf("stat secrets.key: %v", err)
		}
		if mode := info.Mode().Perm(); mode&0o077 != 0 {
			t.Fatalf("secrets.key mode = %o, want 0600", mode)
		}
	}
	plain, err := auth.Open(key, file.Profiles[0].PasswordEnc)
	if err != nil {
		t.Fatalf("decrypt stored password: %v", err)
	}
	if plain != secret {
		t.Fatalf("decrypted password = %q, want %q", plain, secret)
	}

	// List responses carry hasPassword but neither ciphertext nor plaintext.
	status, envelope, rawList := doJSON(t, mux, http.MethodGet, "/api/v1/databases/profiles", nil)
	if status != http.StatusOK {
		t.Fatalf("list status = %d, body = %s", status, rawList)
	}
	if strings.Contains(rawList, secret) || strings.Contains(rawList, "passwordEnc") {
		t.Fatalf("list response leaks secrets: %s", rawList)
	}
	var list struct {
		Available bool             `json:"available"`
		Items     []map[string]any `json:"items"`
	}
	if err := json.Unmarshal(envelope.Data, &list); err != nil {
		t.Fatalf("decode list: %v", err)
	}
	if !list.Available || len(list.Items) != 1 {
		t.Fatalf("list available=%v items=%d", list.Available, len(list.Items))
	}
	if _, ok := list.Items[0]["password"]; ok {
		t.Fatal("list item exposes password")
	}
	if list.Items[0]["hasPassword"] != true {
		t.Fatal("list item hasPassword != true")
	}

	// GET without reveal is masked; with reveal=1 it returns the password.
	status, _, rawDetail := doJSON(t, mux, http.MethodGet, "/api/v1/databases/profiles/"+profile.ID, nil)
	if status != http.StatusOK {
		t.Fatalf("detail status = %d", status)
	}
	if strings.Contains(rawDetail, secret) {
		t.Fatal("plain detail leaks the password")
	}
	var detail map[string]any
	if err := json.Unmarshal([]byte(rawDetail), &detail); err != nil {
		t.Fatalf("decode detail: %v", err)
	}
	if data, ok := detail["data"].(map[string]any); ok {
		if _, has := data["password"]; has {
			t.Fatal("detail without reveal includes password")
		}
	}

	status, revealEnvelope, _ := doJSON(t, mux, http.MethodGet,
		"/api/v1/databases/profiles/"+profile.ID+"?reveal=1", nil)
	if status != http.StatusOK {
		t.Fatalf("reveal status = %d", status)
	}
	var revealed map[string]any
	if err := json.Unmarshal(revealEnvelope.Data, &revealed); err != nil {
		t.Fatalf("decode reveal: %v", err)
	}
	if revealed["password"] != secret {
		t.Fatalf("reveal password = %v, want %q", revealed["password"], secret)
	}

	// password:null clears the stored secret.
	status, envelope, _ = doJSON(t, mux, http.MethodPatch,
		"/api/v1/databases/profiles/"+profile.ID, map[string]any{"password": nil})
	if status != http.StatusOK {
		t.Fatalf("patch status = %d", status)
	}
	patched := decodeData[DatabaseProfile](t, envelope)
	if patched.HasPassword {
		t.Fatal("hasPassword still true after password:null")
	}
	_, revealEnvelope, _ = doJSON(t, mux, http.MethodGet,
		"/api/v1/databases/profiles/"+profile.ID+"?reveal=1", nil)
	var afterClear map[string]any
	if err := json.Unmarshal(revealEnvelope.Data, &afterClear); err != nil {
		t.Fatalf("decode reveal after clear: %v", err)
	}
	if _, has := afterClear["password"]; has {
		t.Fatal("reveal returned a password after it was cleared")
	}

	// A new password is sealed again.
	status, _, _ = doJSON(t, mux, http.MethodPatch,
		"/api/v1/databases/profiles/"+profile.ID, map[string]any{"password": "rotated"})
	if status != http.StatusOK {
		t.Fatalf("patch password status = %d", status)
	}
	_, revealEnvelope, _ = doJSON(t, mux, http.MethodGet,
		"/api/v1/databases/profiles/"+profile.ID+"?reveal=1", nil)
	var rotated map[string]any
	if err := json.Unmarshal(revealEnvelope.Data, &rotated); err != nil {
		t.Fatalf("decode rotated reveal: %v", err)
	}
	if rotated["password"] != "rotated" {
		t.Fatalf("rotated password = %v, want rotated", rotated["password"])
	}
}

func TestHandoffTicketOneShotAndExpiry(t *testing.T) {
	module, mux, _ := newTestModule(t, nil)
	const secret = "p@ss:w/rd"
	profile := mustCreateProfile(t, mux, postgresInput("handoff-pg", secret))

	status, envelope, raw := doJSON(t, mux, http.MethodPost,
		"/api/v1/databases/profiles/"+profile.ID+"/handoff", map[string]any{"ttlSec": 30})
	if status != http.StatusOK {
		t.Fatalf("handoff status = %d, body = %s", status, raw)
	}
	ticket := decodeData[HandoffTicket](t, envelope)
	if ticket.Ticket == "" || !strings.HasPrefix(ticket.Ticket, "tk_") {
		t.Fatalf("ticket = %q", ticket.Ticket)
	}
	if ticket.RedeemURL != handoffRedeemURL {
		t.Fatalf("redeemUrl = %q, want %q", ticket.RedeemURL, handoffRedeemURL)
	}
	if ticket.Kind != kindPostgres {
		t.Fatalf("kind = %q", ticket.Kind)
	}

	status, envelope, raw = doJSON(t, mux, http.MethodPost,
		"/api/v1/databases/handoff/redeem", map[string]any{"ticket": ticket.Ticket})
	if status != http.StatusOK {
		t.Fatalf("redeem status = %d, body = %s", status, raw)
	}
	payload := decodeData[HandoffPayload](t, envelope)
	if payload.ProfileID != profile.ID {
		t.Fatalf("payload profileId = %q", payload.ProfileID)
	}
	if payload.Password == nil || *payload.Password != secret {
		t.Fatalf("payload password = %v", payload.Password)
	}
	if !strings.HasPrefix(payload.ConnectionString, "postgres://") {
		t.Fatalf("connectionString = %q", payload.ConnectionString)
	}

	// Second redemption of the same ticket must fail with NOT_FOUND.
	status, envelope, _ = doJSON(t, mux, http.MethodPost,
		"/api/v1/databases/handoff/redeem", map[string]any{"ticket": ticket.Ticket})
	if status != http.StatusNotFound {
		t.Fatalf("second redeem status = %d, want 404", status)
	}
	if envelope.Error == nil || envelope.Error.Code != "NOT_FOUND" {
		t.Fatalf("second redeem error = %+v", envelope.Error)
	}

	// Force an expired ticket and redeem it.
	status, envelope, _ = doJSON(t, mux, http.MethodPost,
		"/api/v1/databases/profiles/"+profile.ID+"/handoff", map[string]any{"ttlSec": 10})
	if status != http.StatusOK {
		t.Fatalf("second handoff status = %d", status)
	}
	expired := decodeData[HandoffTicket](t, envelope)
	module.tickets.mu.Lock()
	entry := module.tickets.items[expired.Ticket]
	entry.expires = time.Now().Add(-time.Second)
	module.tickets.items[expired.Ticket] = entry
	module.tickets.mu.Unlock()
	status, envelope, _ = doJSON(t, mux, http.MethodPost,
		"/api/v1/databases/handoff/redeem", map[string]any{"ticket": expired.Ticket})
	if status != http.StatusNotFound || envelope.Error == nil || envelope.Error.Code != "NOT_FOUND" {
		t.Fatalf("expired redeem status = %d error = %+v", status, envelope.Error)
	}

	// TTL outside 10-300 is a BAD_REQUEST.
	status, envelope, _ = doJSON(t, mux, http.MethodPost,
		"/api/v1/databases/profiles/"+profile.ID+"/handoff", map[string]any{"ttlSec": 5})
	if status != http.StatusBadRequest || envelope.Error == nil || envelope.Error.Code != "BAD_REQUEST" {
		t.Fatalf("bad ttl status = %d error = %+v", status, envelope.Error)
	}
}

func TestProfileValidation(t *testing.T) {
	_, mux, _ := newTestModule(t, nil)
	mustCreateProfile(t, mux, postgresInput("Unique", "pw"))

	status, envelope, _ := doJSON(t, mux, http.MethodPost, "/api/v1/databases/profiles",
		postgresInput("unique", "pw"))
	if status != http.StatusConflict || envelope.Error == nil || envelope.Error.Code != "CONFLICT" {
		t.Fatalf("duplicate name status = %d error = %+v", status, envelope.Error)
	}

	status, envelope, _ = doJSON(t, mux, http.MethodPost, "/api/v1/databases/profiles",
		DatabaseProfileCreateInput{Name: "redis-with-db", Kind: kindRedis, Host: "127.0.0.1", Database: strPtr("nope")})
	if status != http.StatusBadRequest || envelope.Error == nil {
		t.Fatalf("redis+database status = %d error = %+v", status, envelope.Error)
	}

	status, envelope, _ = doJSON(t, mux, http.MethodPost, "/api/v1/databases/profiles",
		DatabaseProfileCreateInput{Name: "pg-with-redisdb", Kind: kindPostgres, Host: "127.0.0.1", RedisDB: intPtr(2)})
	if status != http.StatusBadRequest || envelope.Error == nil {
		t.Fatalf("postgres+redisDb status = %d error = %+v", status, envelope.Error)
	}

	status, envelope, _ = doJSON(t, mux, http.MethodPost, "/api/v1/databases/profiles",
		DatabaseProfileCreateInput{Name: "bad-port", Kind: kindPostgres, Host: "127.0.0.1", Port: intPtr(70000)})
	if status != http.StatusBadRequest || envelope.Error == nil {
		t.Fatalf("bad port status = %d error = %+v", status, envelope.Error)
	}

	status, envelope, _ = doJSON(t, mux, http.MethodGet,
		"/api/v1/databases/profiles/db_missing", nil)
	if status != http.StatusNotFound || envelope.Error == nil || envelope.Error.Code != "NOT_FOUND" {
		t.Fatalf("missing profile status = %d error = %+v", status, envelope.Error)
	}

	status, _, _ = doJSON(t, mux, http.MethodDelete, "/api/v1/databases/profiles/db_missing", nil)
	if status != http.StatusNotFound {
		t.Fatalf("delete missing status = %d", status)
	}
}

func TestBackupAndRestoreJobLifecycle(t *testing.T) {
	runner := &recordingRunner{data: []byte("PGDUMP")}
	module, mux, _ := newTestModule(t, runner)

	input := postgresInput("backup-pg", "")
	input.Password = nil
	profile := mustCreateProfile(t, mux, input)

	status, envelope, raw := doJSON(t, mux, http.MethodPost,
		"/api/v1/databases/profiles/"+profile.ID+"/backup", map[string]any{"label": "nightly"})
	if status != http.StatusAccepted {
		t.Fatalf("backup status = %d, body = %s", status, raw)
	}
	job := decodeData[struct {
		Job DatabaseJob `json:"job"`
	}](t, envelope).Job
	if job.Type != jobTypeBackup || job.BackupID == nil || job.Status != jobQueued {
		t.Fatalf("queued job = %+v", job)
	}
	finished := waitJob(t, mux, job.ID)
	if finished.Status != jobSuccess {
		t.Fatalf("backup job = %+v", finished)
	}

	// The backup record and its file exist; the API hides the path.
	status, envelopes, rawList := doJSON(t, mux, http.MethodGet,
		"/api/v1/databases/profiles/"+profile.ID+"/backups", nil)
	if status != http.StatusOK {
		t.Fatalf("backup list status = %d", status)
	}
	if strings.Contains(rawList, `"path"`) {
		t.Fatalf("backup list exposes internal path: %s", rawList)
	}
	var backups struct {
		Items []BackupRecord `json:"items"`
	}
	if err := json.Unmarshal(envelopes.Data, &backups); err != nil {
		t.Fatalf("decode backups: %v", err)
	}
	if len(backups.Items) != 1 {
		t.Fatalf("backups = %d, want 1", len(backups.Items))
	}
	record := backups.Items[0]
	if record.Status != backupSuccess || record.Format != formatCustom || record.SizeBytes != int64(len(runner.data)) {
		t.Fatalf("backup record = %+v", record)
	}
	if record.Label == nil || *record.Label != "nightly" {
		t.Fatalf("backup label = %v", record.Label)
	}
	stored, ok := module.findBackup(record.ID)
	if !ok || stored.Path == "" {
		t.Fatalf("stored backup missing path: %+v", stored)
	}
	if !module.isWithinBackupDir(stored.Path) {
		t.Fatalf("backup path outside backup dir: %s", stored.Path)
	}
	if info, err := os.Stat(stored.Path); err != nil || info.Size() != int64(len(runner.data)) {
		t.Fatalf("backup file stat: info=%v err=%v", info, err)
	}

	// Download streams the raw bytes.
	status, body, headers := doRaw(t, mux, http.MethodGet, "/api/v1/databases/backups/"+record.ID+"/download")
	if status != http.StatusOK || body != string(runner.data) {
		t.Fatalf("download status=%d body=%q", status, body)
	}
	if disposition := headers.Get("Content-Disposition"); !strings.HasPrefix(disposition, "attachment;") {
		t.Fatalf("Content-Disposition = %q", disposition)
	}

	// Restore the backup; confirm:true is required.
	status, envelope, _ = doJSON(t, mux, http.MethodPost,
		"/api/v1/databases/profiles/"+profile.ID+"/restore",
		map[string]any{"backupId": record.ID, "confirm": false})
	if status != http.StatusBadRequest {
		t.Fatalf("restore without confirm status = %d", status)
	}
	status, envelope, raw = doJSON(t, mux, http.MethodPost,
		"/api/v1/databases/profiles/"+profile.ID+"/restore",
		map[string]any{"backupId": record.ID, "confirm": true})
	if status != http.StatusAccepted {
		t.Fatalf("restore status = %d, body = %s", status, raw)
	}
	restoreJob := decodeData[struct {
		Job DatabaseJob `json:"job"`
	}](t, envelope).Job
	finished = waitJob(t, mux, restoreJob.ID)
	if finished.Status != jobSuccess {
		t.Fatalf("restore job = %+v", finished)
	}
	calls := strings.Join(runner.snapshot(), "\n")
	if !strings.Contains(calls, "pg_dump") || !strings.Contains(calls, "--format=custom") {
		t.Fatalf("pg_dump was not invoked correctly:\n%s", calls)
	}
	if !strings.Contains(calls, "pg_restore") || !strings.Contains(calls, "--clean") {
		t.Fatalf("pg_restore was not invoked correctly:\n%s", calls)
	}

	// Deleting the record removes the file.
	status, _, _ = doJSON(t, mux, http.MethodDelete, "/api/v1/databases/backups/"+record.ID, nil)
	if status != http.StatusOK {
		t.Fatalf("delete backup status = %d", status)
	}
	if _, err := os.Stat(stored.Path); !os.IsNotExist(err) {
		t.Fatalf("backup file still exists: %v", err)
	}
	if _, ok := module.findBackup(record.ID); ok {
		t.Fatal("backup record still exists after delete")
	}
}

func TestBackupUnavailableWithoutPgDump(t *testing.T) {
	_, mux, _ := newTestModule(t, &failingRunner{})
	profile := mustCreateProfile(t, mux, postgresInput("no-tools", "pw"))

	status, envelope, raw := doJSON(t, mux, http.MethodPost,
		"/api/v1/databases/profiles/"+profile.ID+"/backup", map[string]any{})
	if status != http.StatusServiceUnavailable {
		t.Fatalf("backup status = %d, want 503, body = %s", status, raw)
	}
	if envelope.Error == nil || envelope.Error.Code != "UNAVAILABLE" {
		t.Fatalf("backup error = %+v", envelope.Error)
	}
	hint, _ := envelope.Error.Details["hint"].(string)
	if strings.TrimSpace(hint) == "" {
		t.Fatalf("UNAVAILABLE must carry details.hint, got %+v", envelope.Error.Details)
	}

	status, envelope, _ = doJSON(t, mux, http.MethodGet, "/api/v1/databases/jobs", nil)
	if status != http.StatusOK {
		t.Fatalf("jobs status = %d", status)
	}
	var jobs struct {
		Items []DatabaseJob `json:"items"`
	}
	if err := json.Unmarshal(envelope.Data, &jobs); err != nil {
		t.Fatalf("decode jobs: %v", err)
	}
	if len(jobs.Items) != 0 {
		t.Fatalf("rejected backup must not create a job, got %d", len(jobs.Items))
	}

	// Profiles remain manageable and backups list is available.
	status, envelope, _ = doJSON(t, mux, http.MethodGet,
		"/api/v1/databases/profiles/"+profile.ID+"/backups", nil)
	if status != http.StatusOK {
		t.Fatalf("backups list status = %d", status)
	}
	var backups struct {
		Available bool           `json:"available"`
		Items     []BackupRecord `json:"items"`
	}
	if err := json.Unmarshal(envelope.Data, &backups); err != nil {
		t.Fatalf("decode backups: %v", err)
	}
	if !backups.Available || len(backups.Items) != 0 {
		t.Fatalf("backups available=%v items=%d", backups.Available, len(backups.Items))
	}

	// Downloading an unknown backup is a JSON NOT_FOUND, never a file.
	status, envelope, _ = doJSON(t, mux, http.MethodGet,
		"/api/v1/databases/backups/bk_missing/download", nil)
	if status != http.StatusNotFound || envelope.Error == nil || envelope.Error.Code != "NOT_FOUND" {
		t.Fatalf("missing download status = %d error = %+v", status, envelope.Error)
	}
}

func TestRestartFailsInterruptedJobsAndBackups(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "backups"), 0o755); err != nil {
		t.Fatalf("mkdir backups: %v", err)
	}
	now := nowStamp()
	backups := backupsFile{Version: 1, Backups: []backupEntry{{
		ID:        "bk_interrupted",
		ProfileID: "db_gone",
		Kind:      kindPostgres,
		Format:    formatCustom,
		FileName:  "old.dump",
		Status:    backupRunning,
		CreatedAt: now,
		Path:      filepath.Join(dir, "backups", "databases", "old.dump"),
	}}}
	backupData, _ := json.Marshal(backups)
	if err := os.WriteFile(filepath.Join(dir, "backups", "databases.json"), backupData, 0o600); err != nil {
		t.Fatalf("write databases.json: %v", err)
	}
	jobs := jobsFile{Version: 1, Jobs: []jobEntry{{
		DatabaseJob: DatabaseJob{
			ID:        "job_interrupted",
			ProfileID: "db_gone",
			Type:      jobTypeBackup,
			Status:    jobQueued,
		},
		CreatedAt: now,
	}}}
	jobData, _ := json.Marshal(jobs)
	if err := os.WriteFile(filepath.Join(dir, "backups", "jobs.json"), jobData, 0o600); err != nil {
		t.Fatalf("write jobs.json: %v", err)
	}

	_, mux, _ := newTestModuleAt(t, dir, nil)

	status, envelope, _ := doJSON(t, mux, http.MethodGet, "/api/v1/databases/jobs/job_interrupted", nil)
	if status != http.StatusOK {
		t.Fatalf("get job status = %d", status)
	}
	job := decodeData[DatabaseJob](t, envelope)
	if job.Status != jobFailed || job.Error == nil {
		t.Fatalf("restarted job = %+v", job)
	}

	status, envelope, _ = doJSON(t, mux, http.MethodGet, "/api/v1/databases/backups/bk_interrupted", nil)
	if status != http.StatusOK {
		t.Fatalf("get backup status = %d", status)
	}
	record := decodeData[BackupRecord](t, envelope)
	if record.Status != backupFailed || record.Error == nil {
		t.Fatalf("restarted backup = %+v", record)
	}
}

func TestBackupPathGuard(t *testing.T) {
	module, _, dir := newTestModule(t, nil)
	if !module.isWithinBackupDir(filepath.Join(dir, "backups", "databases", "bk_x.dump")) {
		t.Fatal("path inside backup dir rejected")
	}
	if module.isWithinBackupDir(filepath.Join(dir, "backups", "databases", "..", "escape.dump")) {
		t.Fatal("path traversal accepted")
	}
	if module.isWithinBackupDir(filepath.Join(dir, "databases.json")) {
		t.Fatal("unrelated path accepted")
	}
	if module.isWithinBackupDir("") {
		t.Fatal("empty path accepted")
	}
}

func TestBuildRedisStatsFromInfo(t *testing.T) {
	raw := strings.Join([]string{
		"# Server",
		"redis_version:7.2.4",
		"uptime_in_seconds:12345",
		"role:slave",
		"# Clients",
		"connected_clients:5",
		"# Memory",
		"used_memory:1048576",
		"maxmemory:0",
		"# Stats",
		"instantaneous_ops_per_sec:42",
		"keyspace_hits:90",
		"keyspace_misses:10",
		"# Keyspace",
		"db1:keys=3,expires=1,avg_ttl=0",
		"db0:keys=10,expires=2,avg_ttl=0",
	}, "\r\n")
	info := parseRedisInfo(raw)
	if info["redis_version"] != "7.2.4" {
		t.Fatalf("redis_version = %q", info["redis_version"])
	}
	stats := buildRedisStats(info, nil)
	if stats.Kind != kindRedis || stats.Version != "7.2.4" {
		t.Fatalf("stats kind/version = %q/%q", stats.Kind, stats.Version)
	}
	if stats.UptimeSec != 12345 || stats.ConnectedClients != 5 || stats.UsedMemoryBytes != 1048576 {
		t.Fatalf("unexpected stats %+v", stats)
	}
	if stats.Role != "replica" {
		t.Fatalf("role = %q, want replica", stats.Role)
	}
	if stats.MaxMemoryBytes != nil {
		t.Fatalf("maxmemory 0 must map to null, got %v", *stats.MaxMemoryBytes)
	}
	if stats.OpsPerSec == nil || *stats.OpsPerSec != 42 {
		t.Fatalf("opsPerSec = %v", stats.OpsPerSec)
	}
	if len(stats.Keyspace) != 2 || stats.Keyspace[0].DB != 0 || stats.Keyspace[1].DB != 1 {
		t.Fatalf("keyspace = %+v", stats.Keyspace)
	}
	if stats.Keyspace[0].Keys != 10 || stats.Keyspace[0].Expires != 2 {
		t.Fatalf("keyspace[0] = %+v", stats.Keyspace[0])
	}
	if stats.TotalKeys != 13 {
		t.Fatalf("totalKeys = %d, want 13", stats.TotalKeys)
	}
	if stats.CacheHitRatio == nil || *stats.CacheHitRatio != 0.9 {
		t.Fatalf("cacheHitRatio = %v, want 0.9", stats.CacheHitRatio)
	}
	if stats.Slowlog != nil {
		t.Fatalf("empty slowlog should be omitted, got %+v", stats.Slowlog)
	}

	sentinel := buildRedisStats(map[string]string{"role": "sentinel"}, nil)
	if sentinel.Role != "sentinel" || sentinel.Version != "" || sentinel.Keyspace == nil {
		t.Fatalf("sentinel stats = %+v", sentinel)
	}
	unknown := buildRedisStats(map[string]string{"role": "something"}, nil)
	if unknown.Role != "unknown" {
		t.Fatalf("unknown role = %q", unknown.Role)
	}
}

func TestPostgresStatsWithRealServer(t *testing.T) {
	dsn := strings.TrimSpace(os.Getenv("MPANEL_TEST_PG_DSN"))
	if dsn == "" {
		t.Skip("未设置 MPANEL_TEST_PG_DSN，跳过真实 PostgreSQL 统计测试")
	}
	db, err := sql.Open("postgres", dsn)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer db.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	stats, err := collectPostgresStats(ctx, db)
	if err != nil {
		t.Fatalf("collectPostgresStats: %v", err)
	}
	if stats.Kind != kindPostgres || stats.Version == "" {
		t.Fatalf("unexpected stats %+v", stats)
	}
	if stats.Connections.Total <= 0 {
		t.Fatalf("connections.total = %d", stats.Connections.Total)
	}
}

func TestRedisStatsWithRealServer(t *testing.T) {
	addr := strings.TrimSpace(os.Getenv("MPANEL_TEST_REDIS_ADDR"))
	if addr == "" {
		t.Skip("未设置 MPANEL_TEST_REDIS_ADDR，跳过真实 Redis 统计测试")
	}
	client := redis.NewClient(&redis.Options{Addr: addr})
	defer client.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	raw, err := client.Info(ctx, "all").Result()
	if err != nil {
		t.Fatalf("INFO: %v", err)
	}
	stats := buildRedisStats(parseRedisInfo(raw), nil)
	if stats.Kind != kindRedis || stats.Version == "" {
		t.Fatalf("unexpected stats %+v", stats)
	}
}
