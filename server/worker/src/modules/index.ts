import type { WorkerModule } from '../registry.js';
import { createCertsModule } from './certs/index.js';
import { createContainersModule } from './containers/index.js';
import { createDatabasesModule } from './databases/index.js';
import { createFilesModule } from './files/index.js';
import { createSitesModule } from './sites/index.js';
import { createTasksModule } from './tasks/index.js';
import { createTerminalModule } from './terminal/index.js';

/** Registration order is part of the contract. */
export function createWorkerModules(): WorkerModule[] {
  return [
    createSitesModule(),
    createCertsModule(),
    createDatabasesModule(),
    createContainersModule(),
    createFilesModule(),
    createTerminalModule(),
    createTasksModule(),
  ];
}
