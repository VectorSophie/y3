export class Y3ParseError extends Error {
  constructor(
    public readonly line: number,
    public readonly text: string,
    public readonly explanation: string,
  ) {
    super(`Parse error at line ${line}: ${explanation}\n> ${text}`);
    this.name = "Y3ParseError";
  }
}

export class Y3RuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Y3RuntimeError";
  }
}
