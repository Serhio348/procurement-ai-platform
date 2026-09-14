import { evaluateSearch, formatSearchEvalReport } from "./evaluate.js";
import { formatNkuClassReport, NKU_PUMP_CASES, NKU_PUMP_PROFILE } from "./evaluate-nku-pumps.js";

const report = evaluateSearch(NKU_PUMP_CASES, NKU_PUMP_PROFILE);
process.stdout.write(`${formatSearchEvalReport(report)}\n\n${formatNkuClassReport(report)}\n`);
