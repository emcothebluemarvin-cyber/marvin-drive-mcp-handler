/** Persists one refresh token per account email. */
export interface TokenStore {
  get(email: string): Promise<string | null>;
  set(email: string, refreshToken: string): Promise<void>;
  delete(email: string): Promise<void>;
}

export class InMemoryTokenStore implements TokenStore {
  private readonly tokens = new Map<string, string>();

  async get(email: string): Promise<string | null> {
    return this.tokens.get(email) ?? null;
  }

  async set(email: string, refreshToken: string): Promise<void> {
    this.tokens.set(email, refreshToken);
  }

  async delete(email: string): Promise<void> {
    this.tokens.delete(email);
  }
}
