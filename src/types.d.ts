type GloryEvent = {
  name: string;
  url: URL;
  date: string;
  location: string;
  fights: string[];
};

declare module "playwright" {
  export type Page = {
    goto(
      url: string,
      options?: { waitUntil?: string; timeout?: number }
    ): Promise<unknown>;
    evaluate<T>(pageFunction: () => T): Promise<T>;
    content(): Promise<string>;
  };

  export const chromium: {
    launch(options?: { headless?: boolean }): Promise<{
      newContext(): Promise<{
        newPage(): Promise<Page>;
      }>;
      close(): Promise<void>;
    }>;
  };
}
