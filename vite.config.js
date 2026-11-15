import { defineConfig } from 'vite';
import { request as httpRequest } from 'node:http';

const backendPorts = [3004, 3002, 3005, 3006, 3007, 3008, 3009, 3010];

function isRouteGuardAvailable(port) {
  return new Promise(function (resolve) {
    const request = httpRequest({
      hostname: '127.0.0.1',
      port,
      path: '/api/health'
    }, function (response) {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', function (chunk) {
        body += chunk;
      });
      response.on('end', function () {
        try {
          resolve(response.statusCode === 200 && JSON.parse(body).service === 'RouteGuard API');
        } catch (error) {
          resolve(false);
        }
      });
    });

    request.setTimeout(500, function () {
      request.destroy();
      resolve(false);
    });
    request.on('error', function () {
      resolve(false);
    });
    request.end();
  });
}

async function findBackendTarget() {
  const configuredPort = Number(process.env.ROUTEGUARD_PORT);
  if (Number.isInteger(configuredPort) && configuredPort > 0 && configuredPort <= 65535) {
    return `http://localhost:${configuredPort}`;
  }

  for (const port of backendPorts) {
    if (await isRouteGuardAvailable(port)) return `http://localhost:${port}`;
  }

  return 'http://localhost:3004';
}

export default defineConfig(async function () {
  const backendTarget = await findBackendTarget();
  const backendProxy = {
    '/api': {
      target: backendTarget,
      changeOrigin: true,
      secure: false
    },
    '/admin': {
      target: backendTarget,
      changeOrigin: true,
      secure: false
    }
  };

  return {
    server: {
      port: 5173,
      proxy: backendProxy
    },
    preview: {
      proxy: backendProxy
    }
  };
});
