package containers

import "testing"

func TestBuildRunArgsDefaults(t *testing.T) {
	args, created, pErr := buildRunArgs(ContainerCreateInput{Image: "redis:7-alpine"})
	if pErr != nil {
		t.Fatalf("unexpected error: %v", pErr)
	}
	want := []string{"run", "-d", "--restart", "unless-stopped", "redis:7-alpine"}
	if len(args) != len(want) {
		t.Fatalf("args = %#v", args)
	}
	for i := range want {
		if args[i] != want[i] {
			t.Fatalf("args[%d] = %q, want %q", i, args[i], want[i])
		}
	}
	if created.Image != "redis:7-alpine" || !created.OK {
		t.Fatalf("created = %#v", created)
	}
}

func TestBuildRunArgsFull(t *testing.T) {
	args, _, pErr := buildRunArgs(ContainerCreateInput{
		Image:   "postgres:16",
		Name:    "pg16",
		Env:     map[string]string{"POSTGRES_PASSWORD": "secret"},
		Ports:   []string{"5432:5432", "127.0.0.1:5433:5433/tcp"},
		Volumes: []string{"/opt/mpanel/data/pg:/var/lib/postgresql/data"},
		Network: "mpanel",
		Restart: "always",
		Command: []string{"postgres", "-c", "max_connections=200"},
	})
	if pErr != nil {
		t.Fatalf("unexpected error: %v", pErr)
	}
	want := []string{
		"run", "-d",
		"--name", "pg16",
		"--restart", "always",
		"--publish", "5432:5432",
		"--publish", "127.0.0.1:5433:5433/tcp",
		"--volume", "/opt/mpanel/data/pg:/var/lib/postgresql/data",
		"--env", "POSTGRES_PASSWORD=secret",
		"--network", "mpanel",
		"postgres:16",
		"postgres", "-c", "max_connections=200",
	}
	if len(args) != len(want) {
		t.Fatalf("args = %#v", args)
	}
	for i := range want {
		if args[i] != want[i] {
			t.Fatalf("args[%d] = %q, want %q", i, args[i], want[i])
		}
	}
}

func TestBuildRunArgsRejectsInvalidInput(t *testing.T) {
	cases := []struct {
		name  string
		input ContainerCreateInput
	}{
		{"empty image", ContainerCreateInput{}},
		{"bad image", ContainerCreateInput{Image: "-rm"}},
		{"bad name", ContainerCreateInput{Image: "nginx", Name: "-bad"}},
		{"bad port", ContainerCreateInput{Image: "nginx", Ports: []string{"80"}}},
		{"port out of range", ContainerCreateInput{Image: "nginx", Ports: []string{"70000:80"}}},
		{"bad volume", ContainerCreateInput{Image: "nginx", Volumes: []string{"/data"}}},
		{"bad restart", ContainerCreateInput{Image: "nginx", Restart: "sometimes"}},
		{"bad env key", ContainerCreateInput{Image: "nginx", Env: map[string]string{"1BAD": "x"}}},
		{"bad network", ContainerCreateInput{Image: "nginx", Network: "a b"}},
	}
	for _, tc := range cases {
		if _, _, pErr := buildRunArgs(tc.input); pErr == nil {
			t.Fatalf("%s: expected validation error", tc.name)
		}
	}
}

func TestPortNumbersValid(t *testing.T) {
	for _, ok := range []string{"8080:80", "127.0.0.1:8080:80", "8080:80/udp", "1:65535"} {
		if !portNumbersValid(ok) {
			t.Fatalf("%q should be valid", ok)
		}
	}
	for _, bad := range []string{"0:80", "8080:0", "70000:80", "8080:70000"} {
		if portNumbersValid(bad) {
			t.Fatalf("%q should be invalid", bad)
		}
	}
}
