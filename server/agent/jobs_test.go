package agent

import (
	"context"
	"testing"
	"time"

	"github.com/sakana-1314/mpanel/server/core/protocol"
)

func waitJob(t *testing.T, manager *JobManager, id string) protocol.Job {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		job, ok := manager.Get(id)
		if !ok {
			t.Fatalf("job %s missing", id)
		}
		switch job.Status {
		case protocol.JobStatusSucceeded, protocol.JobStatusFailed, protocol.JobStatusCancelled:
			return job
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("job %s did not finish", id)
	return protocol.Job{}
}

func TestJobManagerRunsAndReports(t *testing.T) {
	manager := NewJobManager(t.TempDir(), nil)
	job, err := manager.Submit(JobSpec{
		Kind:  "test.run",
		Title: "测试任务",
		Run: func(ctx context.Context, reporter JobReporter) (any, error) {
			reporter.SetProgress(30, "第一步")
			reporter.Log("hello")
			reporter.SetIndeterminate(true)
			reporter.SetProgress(80, "第二步")
			return map[string]any{"ok": true}, nil
		},
	})
	if err != nil {
		t.Fatalf("Submit: %v", err)
	}
	finished := waitJob(t, manager, job.ID)
	if finished.Status != protocol.JobStatusSucceeded || finished.Progress != 100 {
		t.Fatalf("unexpected job: %+v", finished)
	}
	if finished.Step != "完成" || finished.Result == nil {
		t.Fatalf("missing terminal fields: %+v", finished)
	}
	if finished.Logs == "" {
		t.Fatal("job logs missing")
	}
	if len(manager.List(string(protocol.JobStatusSucceeded), "test.run")) != 1 {
		t.Fatal("list filter failed")
	}
	if len(manager.List("", "other")) != 0 {
		t.Fatal("kind filter failed")
	}
}

func TestJobManagerFailureAndCancel(t *testing.T) {
	manager := NewJobManager(t.TempDir(), nil)
	failed, err := manager.Submit(JobSpec{
		Kind:  "test.fail",
		Title: "失败任务",
		Run: func(ctx context.Context, reporter JobReporter) (any, error) {
			return nil, &protocol.PanelError{Code: protocol.CodeBadRequest, Message: "坏了", Hint: "修一下"}
		},
	})
	if err != nil {
		t.Fatalf("Submit: %v", err)
	}
	finished := waitJob(t, manager, failed.ID)
	if finished.Status != protocol.JobStatusFailed || finished.Error == nil || finished.Error.Code != protocol.CodeBadRequest {
		t.Fatalf("failure not recorded: %+v", finished)
	}
	if finished.Error.Hint != "修一下" {
		t.Fatalf("hint missing: %+v", finished.Error)
	}

	cancelled, err := manager.Submit(JobSpec{
		Kind:        "test.cancel",
		Title:       "取消任务",
		Cancellable: true,
		Run: func(ctx context.Context, reporter JobReporter) (any, error) {
			reporter.SetProgress(10, "等待取消")
			<-ctx.Done()
			return nil, ctx.Err()
		},
	})
	if err != nil {
		t.Fatalf("Submit: %v", err)
	}
	time.Sleep(30 * time.Millisecond)
	if _, ok := manager.Cancel(cancelled.ID); !ok {
		t.Fatal("Cancel returned false")
	}
	finished = waitJob(t, manager, cancelled.ID)
	if finished.Status != protocol.JobStatusCancelled {
		t.Fatalf("expected cancelled, got %+v", finished)
	}
}

func TestJobManagerMarksInterruptedJobs(t *testing.T) {
	dir := t.TempDir()
	manager := NewJobManager(dir, nil)
	blocked, err := manager.Submit(JobSpec{
		Kind:  "test.slow",
		Title: "慢任务",
		Run: func(ctx context.Context, reporter JobReporter) (any, error) {
			time.Sleep(200 * time.Millisecond)
			return nil, nil
		},
	})
	if err != nil {
		t.Fatalf("Submit: %v", err)
	}
	waitJob(t, manager, blocked.ID)

	// Simulate a persisted running record by writing it through a fresh manager.
	manager.mu.Lock()
	rec := manager.jobs[blocked.ID]
	rec.job.Status = protocol.JobStatusRunning
	manager.persistLocked()
	manager.mu.Unlock()

	reloaded := NewJobManager(dir, nil)
	job, ok := reloaded.Get(blocked.ID)
	if !ok {
		t.Fatal("persisted job missing")
	}
	if job.Status != protocol.JobStatusFailed || job.Error == nil {
		t.Fatalf("interrupted job should be failed: %+v", job)
	}
}
