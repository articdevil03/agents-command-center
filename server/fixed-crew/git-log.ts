// Transport output can echo URLs, including credentials configured outside the app.
export function safeGitText(text: string): string {
  return text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s"'<>]+/gi, (url) => {
    return url.replace(/(\/\/)[^/\s]*@/, "$1").replace(/[?#].*$/, "");
  });
}
