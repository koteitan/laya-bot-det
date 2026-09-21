import { Component, type ErrorInfo, type ReactNode } from "react";

/** Keeps one thrown render from leaving a blank page with nothing to act on.
 *  The message and the reset link are the only things a phone can offer someone
 *  who cannot open devtools. */
export class ErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("laya-bot-det:", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="boundary">
        <h1>エラーで停止しました</h1>
        <p>{this.state.error.message}</p>
        <p>
          <a href="./">再読み込み</a> ・ <a href="./?reset">保存データを消す</a>
        </p>
      </div>
    );
  }
}
