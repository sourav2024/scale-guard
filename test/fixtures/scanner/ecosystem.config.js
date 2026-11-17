module.exports = {
  apps: [{ name: "api", script: "dist/server.js", instances: 4, exec_mode: "cluster" }],
};
