# AI Therapist — self-hosted Docker image
# Uses debian-slim (not alpine) so the bcrypt native module resolves a prebuilt binary.
FROM node:20-bookworm-slim

WORKDIR /app

# Install ALL dependencies. The server statically imports `vite` (a devDependency)
# at the top of src/server/index.js, so devDeps must be present at runtime too.
# NODE_ENV is intentionally left unset here so `npm ci` does not prune devDeps;
# the `start` script sets NODE_ENV=production at runtime.
COPY package.json package-lock.json ./
RUN npm ci

# Copy source and build the client + SSR bundles into dist/
COPY . .
RUN npm run build

EXPOSE 3067

CMD ["npm", "start"]
