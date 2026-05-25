import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { Download, Info } from "lucide-react";

function App() {
  const [state, setState] = useState("ready");
  const [infoOpen, setInfoOpen] = useState(false);

  async function installForMac() {
    setState("launching");
    try {
      const tokenResponse = await fetch("/api/desktop/launch-token", {
        method: "GET",
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      if (!tokenResponse.ok) throw new Error(`HTTP ${tokenResponse.status}`);
      const { token } = await tokenResponse.json();
      if (!token) throw new Error("Missing launch token");

      const response = await fetch("/api/desktop/launch", {
        method: "POST",
        headers: { "X-Desktop-Launch-Token": token },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setState("opening");
    } catch {
      setState("failed");
    }
  }

  return (
    <main className="install-page">
      <button className="info-button" type="button" aria-label="Info" onClick={() => setInfoOpen(true)}>
        <Info aria-hidden="true" size={18} />
      </button>

      <section className="install-card">
        <div className="mark">⌘</div>
        <h1>Codexa</h1>
        <button className="install-button" type="button" onClick={installForMac}>
          <Download aria-hidden="true" size={18} />
          Install for Mac
        </button>
        <p className="status">{statusText(state)}</p>
      </section>

      {infoOpen ? (
        <dialog className="info-dialog" open>
          <button className="close-button" type="button" aria-label="Close" onClick={() => setInfoOpen(false)}>
            x
          </button>
          <p>Codexa links Codex, opens macOS permission panes, and keeps work inside the current Codex project.</p>
        </dialog>
      ) : null}
    </main>
  );
}

function statusText(state) {
  if (state === "launching") return "Opening...";
  if (state === "opening") return "Opened.";
  if (state === "failed") return "Open with npm run desktop.";
  return "";
}

createRoot(document.querySelector("#root")).render(<App />);
