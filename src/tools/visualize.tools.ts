import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { ProjectRepository } from '../adapters/db/repositories/project.repository.js';
import { EnvironmentRepository } from '../adapters/db/repositories/environment.repository.js';
import { ServiceRepository } from '../adapters/db/repositories/service.repository.js';
import { ComponentRepository } from '../adapters/db/repositories/component.repository.js';
import { ConnectionRepository } from '../adapters/db/repositories/connection.repository.js';
import { RunRepository } from '../adapters/db/repositories/run.repository.js';
import { generateVisualizationHtml } from './visualize.template.js';

const projectRepo = new ProjectRepository();
const envRepo = new EnvironmentRepository();
const serviceRepo = new ServiceRepository();
const componentRepo = new ComponentRepository();
const connectionRepo = new ConnectionRepository();
const runRepo = new RunRepository();

export function registerVisualizeTools(server: McpServer): void {
  server.tool(
    'visualize',
    'Generate a 3D infrastructure visualization as a self-contained HTML file',
    {
      projectName: z.string().optional().describe('Project name'),
      projectId: z.string().uuid().optional().describe('Project ID'),
    },
    async ({ projectName, projectId }) => {
      // Resolve project
      let project;
      if (projectId) {
        project = projectRepo.findById(projectId);
      } else if (projectName) {
        project = projectRepo.findByName(projectName);
      } else {
        const all = projectRepo.findAll();
        if (all.length === 1) project = all[0];
        else {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: all.length === 0 ? 'No projects found' : 'Multiple projects found. Specify projectName or projectId.', projects: all.map(p => ({ id: p.id, name: p.name })) }) }],
          };
        }
      }

      if (!project) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: 'Project not found' }) }] };
      }

      const environments = envRepo.findByProjectId(project.id);
      const services = serviceRepo.findByProjectId(project.id);
      const connections = connectionRepo.findAll();
      const recentRuns = runRepo.findByProjectId(project.id, 10);

      const components = environments.flatMap(env =>
        componentRepo.findByEnvironmentId(env.id).map(c => ({
          id: c.id,
          type: c.type,
          envId: env.id,
          envName: env.name,
        }))
      );

      const data = {
        project: { id: project.id, name: project.name },
        environments: environments.map(e => ({ id: e.id, name: e.name })),
        services: services.map(s => ({ id: s.id, name: s.name, builder: s.buildConfig?.builder })),
        components,
        connections: connections.map(c => ({ provider: c.provider, status: c.status })),
        recentRuns: recentRuns.map(r => ({ envId: r.environmentId, status: r.status, type: r.type, completedAt: r.completedAt?.toISOString() ?? null })),
      };

      const html = generateVisualizationHtml(data);
      const safeName = project.name.replace(/[^a-zA-Z0-9-_]/g, '-');
      const filePath = path.join(os.tmpdir(), `infraprint-viz-${safeName}.html`);
      fs.writeFileSync(filePath, html, 'utf-8');

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ success: true, message: `3D visualization generated for "${project.name}"`, filePath, note: 'Open this HTML file in a browser to view the interactive 3D infrastructure visualization.' }) }],
      };
    }
  );
}
