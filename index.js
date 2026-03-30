require("dotenv").config();
const { runWorker } = require("./src/worker");

runWorker().catch((err) => {
  console.error("[FATAL]", err.message);
  process.exit(1);
});
