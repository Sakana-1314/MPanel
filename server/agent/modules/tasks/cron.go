package tasks

import (
	"errors"
	"strings"
	"time"

	"github.com/robfig/cron/v3"
)

// cronParser is the strict 5-field parser the panel contract uses (croner
// compatible; no seconds field and no @descriptors).
func cronParser() cron.Parser {
	return cron.NewParser(cron.Minute | cron.Hour | cron.Dom | cron.Month | cron.Dow)
}

// parseSchedule parses a 5-field cron expression in the given location.
func parseSchedule(expression string, loc *time.Location) (cron.Schedule, error) {
	expression = strings.TrimSpace(expression)
	if expression == "" {
		return nil, errors.New("cron 表达式不能为空")
	}
	if len(expression) > 128 {
		return nil, errors.New("cron 表达式最长 128 个字符")
	}
	schedule, err := cronParser().Parse(expression)
	if err != nil {
		return nil, err
	}
	if spec, ok := schedule.(*cron.SpecSchedule); ok {
		if loc == nil {
			loc = time.Local
		}
		spec.Location = loc
	}
	return schedule, nil
}

// nextRunTimes returns the next count activation times formatted in the
// schedule's timezone. A valid but unsatisfiable expression (for example
// 0 0 30 2 *) yields fewer than count entries rather than an error.
func nextRunTimes(expression string, loc *time.Location, count int) ([]string, error) {
	if count <= 0 {
		count = 5
	}
	if count > 10 {
		count = 10
	}
	schedule, err := parseSchedule(expression, loc)
	if err != nil {
		return nil, err
	}
	if loc == nil {
		loc = time.Local
	}
	at := time.Now()
	out := make([]string, 0, count)
	for i := 0; i < count; i++ {
		next := schedule.Next(at)
		if next.IsZero() {
			break
		}
		out = append(out, next.In(loc).Format(time.RFC3339))
		at = next
	}
	return out, nil
}

// loadLocation validates an IANA timezone. Empty means the host's local zone.
func loadLocation(raw string) (*time.Location, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return time.Local, nil
	}
	return time.LoadLocation(raw)
}
