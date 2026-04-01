import jwt from "jsonwebtoken";

const DEV_JWT_SECRET = "duosic-dev-secret-change-me";

export function getJwtSecret() {
  const configuredSecret = process.env.JWT_SECRET?.trim();
  if (configuredSecret) {
    return configuredSecret;
  }

  if (process.env.NODE_ENV === "production") {
    console.warn("JWT_SECRET is not set. Falling back to the development secret.");
  }

  return DEV_JWT_SECRET;
}

export function signAuthToken(user) {
  return jwt.sign(
    {
      sub: user.id,
      email: user.email,
      displayName: user.displayName
    },
    getJwtSecret(),
    { expiresIn: "7d" }
  );
}

export function verifyAuthToken(token) {
  return jwt.verify(token, getJwtSecret());
}

export function extractBearerToken(headerValue) {
  const [scheme, token] = String(headerValue ?? "").split(" ");
  if (scheme !== "Bearer" || !token) {
    return null;
  }

  return token;
}
