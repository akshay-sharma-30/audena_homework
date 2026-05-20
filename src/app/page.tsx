import { AgentPoolStrip, APP_API_TOKEN, CallsApp } from "@/components/CallsApp";

export default function Home() {
  return (
    <main className="min-h-screen">
      <header className="sticky top-0 z-10 bg-panel-bg/85 backdrop-blur border-b border-panel-edge">
        <div className="mx-auto max-w-[1280px] px-6 py-4 flex items-start justify-between gap-6">
          <div>
            <div className="font-display text-[10px] font-medium uppercase tracking-[0.32em] text-ink-500">
              Audena · Calls
            </div>
            <h1 className="mt-1 font-display text-[18px] font-light tracking-[0.04em] text-ink-50">
              Outbound Operator Console
            </h1>
            <p className="mt-1 text-[11px] text-ink-500 max-w-prose">
              Pre-call gates, AMD-aware routing, real-time agent pool — only
              calls that need the agent reach the agent.
            </p>
          </div>
          <div className="hidden md:block">
            <AgentPoolStrip apiToken={APP_API_TOKEN} />
          </div>
        </div>
      </header>

      <section className="mx-auto max-w-[1280px] px-6 py-8">
        <CallsApp />
      </section>

      <footer className="mx-auto max-w-[1280px] px-6 py-8 border-t border-panel-edge mt-8">
        <div className="font-mono text-[10px] text-ink-700 flex items-center justify-between">
          <span>v0.1 · sqlite · single-process simulator</span>
          <span>
            <span className="text-signal-amber">amber</span> = signal-lamp ·
            built on a webhook-first state machine
          </span>
        </div>
      </footer>
    </main>
  );
}
