package jobs

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/sakana-1314/mpanel/server/agent"
	"github.com/sakana-1314/mpanel/server/core/protocol"
)

func TestJobRoutes(t *testing.T) {
	manager := agent.NewJobManager(t.TempDir(), nil)
	ctx := &agent.Context{
		Mux:  http.NewServeMux(),
		Jobs: manager,
	}
	module := New()
	if err := module.Register(ctx); err != nil {
		t.Fatalf("Register: %v", err)
	}

	started, err := manager.Submit(agent.JobSpec{
		Kind:  "test.route",
		Title: "路由任务",
		Run: func(ctx context.Context, reporter agent.JobReporter) (any, error) {
			reporter.SetProgress(50, "执行中")
			return map[string]any{"ok": true}, nil
		},
	})
	if err != nil {
		t.Fatalf("Submit: %v", err)
	}

	// Wait for completion so list/get exercise a terminal snapshot.
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		job, _ := manager.Get(started.ID)
		if job.Status == protocol.JobStatusSucceeded {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}

	list := httptest.NewRecorder()
	ctx.Mux.ServeHTTP(list, httptest.NewRequest(http.MethodGet, "/api/v1/jobs?kind=test.route", nil))
	if list.Code != http.StatusOK {
		t.Fatalf("list status = %d", list.Code)
	}
	var listEnvelope struct {
		OK   bool                              `json:"ok"`
		Data protocol.ListResult[protocol.Job] `json:"data"`
	}
	if err := json.Unmarshal(list.Body.Bytes(), &listEnvelope); err != nil {
		t.Fatal(err)
	}
	if !listEnvelope.OK || len(listEnvelope.Data.Items) != 1 {
		t.Fatalf("list envelope = %s", list.Body.String())
	}

	get := httptest.NewRecorder()
	ctx.Mux.ServeHTTP(get, httptest.NewRequest(http.MethodGet, "/api/v1/jobs/"+started.ID, nil))
	if get.Code != http.StatusOK {
		t.Fatalf("get status = %d", get.Code)
	}

	cancel := httptest.NewRecorder()
	ctx.Mux.ServeHTTP(cancel, httptest.NewRequest(http.MethodPost, "/api/v1/jobs/"+started.ID+"/cancel", nil))
	if cancel.Code != http.StatusOK {
		t.Fatalf("cancel status = %d", cancel.Code)
	}

	missing := httptest.NewRecorder()
	ctx.Mux.ServeHTTP(missing, httptest.NewRequest(http.MethodGet, "/api/v1/jobs/job_missing", nil))
	if missing.Code != http.StatusNotFound {
		t.Fatalf("missing status = %d", missing.Code)
	}
}
