export function checkEnviromentVariables() {
  const envVars = [
    // Core
    "MONGO_DB",
    "CORS_ORIGIN",
  ];

  const envVarsLength = envVars.length;

  for (let i = 0; i < envVarsLength; i++) {
    if (!process.env[envVars[i]]) {
      console.error(`${envVars[i]} not found, check environment`);
      process.exit(1);
    }
  }
}
