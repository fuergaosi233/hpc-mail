// Node replacement for the small Cloudflare EmailMessage data container.
export class EmailMessage {
  constructor(public from: string, public to: string, public raw: string | ReadableStream) {}
}
