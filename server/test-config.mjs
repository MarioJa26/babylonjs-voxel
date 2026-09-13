import { loadServerConfig } from './src/config/ServerConfig.ts'; const c = loadServerConfig(); console.log(JSON.stringify(c, null, 2));
