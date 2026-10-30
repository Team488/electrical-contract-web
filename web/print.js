import { api } from "./api.js";
import { buildModel } from "./model.js";
import { reportText } from "./report.js";

const status = document.getElementById("status");
try {
  const state = await api.state();
  const text = reportText(buildModel(state));
  document.getElementById("report").textContent = text;
  status.textContent = `${state.robot.name}, revision ${state.robot.rev}`;
  document.getElementById("print").onclick = () => window.print();
  document.getElementById("download").onclick = () => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    a.download = `electrical-report-rev${state.robot.rev}.txt`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
} catch (e) {
  status.textContent = e.message;
}
