import { cronJobs } from "convex/server";
import { api } from "./_generated/api";

const crons = cronJobs();

crons.daily(
  "daily sync",
  { hourUTC: 0, minuteUTC: 0 },
  api.sync.syncAllUsers
);

export default crons;

