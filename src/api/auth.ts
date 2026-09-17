import type { IncomingMessage } from "node:http";

export type AuthPrincipal = {
  tenantId: string;
  actorId: string;
  scopes: string[];
};

export interface Authenticator {
  authenticate(request: IncomingMessage): Promise<AuthPrincipal>;
}

export class BearerTokenAuthenticator implements Authenticator {
  public constructor(
    private readonly token: string,
    private readonly principal: AuthPrincipal,
  ) {}

  public async authenticate(request: IncomingMessage): Promise<AuthPrincipal> {
    const authorization = request.headers.authorization;
    if (authorization !== `Bearer ${this.token}`) {
      const error = new Error("Credenciais ausentes ou inválidas.");
      error.name = "UnauthorizedError";
      throw error;
    }
    return this.principal;
  }
}
