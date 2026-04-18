import React from "react";

type State = { err: Error | null };

export default class RootErrorBoundary extends React.Component<React.PropsWithChildren, State> {
  state: State = { err: null };

  static getDerivedStateFromError(err: Error): State {
    return { err };
  }

  render() {
    if (this.state.err) {
      return (
        <div style={{ padding: 24, fontFamily: "system-ui, sans-serif", maxWidth: 720, margin: "0 auto" }}>
          <h1 style={{ marginTop: 0, fontSize: "1.25rem" }}>Ошибка интерфейса</h1>
          <p style={{ color: "#64748b", fontSize: 14 }}>
            Обновите страницу. Если сообщение повторяется — пришлите текст ниже разработчику.
          </p>
          <pre
            style={{
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              background: "#fef2f2",
              color: "#991b1b",
              padding: 12,
              borderRadius: 8,
              fontSize: 13,
            }}
          >
            {this.state.err.message}
            {this.state.err.stack ? `\n\n${this.state.err.stack}` : ""}
          </pre>
        </div>
      );
    }
    return this.props.children;
  }
}
