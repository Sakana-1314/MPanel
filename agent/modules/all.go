// Package modules aggregates every feature module the agent exposes.
package modules

import (
	"github.com/sakana-1314/mpanel/agent"
	"github.com/sakana-1314/mpanel/agent/modules/certs"
	"github.com/sakana-1314/mpanel/agent/modules/containers"
	"github.com/sakana-1314/mpanel/agent/modules/databases"
	"github.com/sakana-1314/mpanel/agent/modules/files"
	"github.com/sakana-1314/mpanel/agent/modules/sites"
	"github.com/sakana-1314/mpanel/agent/modules/system"
	"github.com/sakana-1314/mpanel/agent/modules/tasks"
	"github.com/sakana-1314/mpanel/agent/modules/terminal"
)

// All returns the module set in registration order.
func All() []agent.Module {
	return []agent.Module{
		system.New(),
		sites.New(),
		certs.New(),
		databases.New(),
		containers.New(),
		files.New(),
		terminal.New(),
		tasks.New(),
	}
}
