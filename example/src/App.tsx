import { useState } from "react";
import "./App.css";
import RateLimitExample from "./components/RateLimitExample";
import Playground from "./components/Playground";
import LazyBenchmark from "./components/LazyBenchmark";

const TABS = {
  benchmark: { label: "Lazy vs. strict", component: LazyBenchmark },
  playground: { label: "Playground", component: Playground },
  hook: { label: "useRateLimit", component: RateLimitExample },
};

type Tab = keyof typeof TABS;

function App() {
  const [tab, setTab] = useState<Tab>("benchmark");
  const Active = TABS[tab].component;

  return (
    <>
      <nav className="sticky top-0 z-10 bg-white/80 backdrop-blur border-b border-gray-200">
        <div className="max-w-7xl mx-auto px-6 flex gap-1">
          {(Object.keys(TABS) as Tab[]).map((key) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`px-5 py-4 font-semibold border-b-2 transition-colors duration-200 ${
                tab === key
                  ? "border-primary-500 text-primary-700"
                  : "border-transparent text-gray-500 hover:text-gray-800"
              }`}
            >
              {TABS[key].label}
            </button>
          ))}
        </div>
      </nav>
      <div className="card">
        <div className="example-container">
          <Active />
        </div>
      </div>
      <p className="read-the-docs">
        These examples demonstrate the rate-limiter component with interactive
        visualization and basic usage patterns
      </p>
    </>
  );
}

export default App;
