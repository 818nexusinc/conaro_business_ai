# CONARO Business AI for a long-running container host (not Vercel; see docs/DEPLOY_VERCEL.md).
# Build from the repository root: docker build -f docker/Dockerfile .
# It lives outside the root so Vercel does not detect it and build a container image.
# Simulation only: no executor exists, so no message, post, payment
# or purchase can leave the application.
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY db ./db
USER node
# Control centre on $PORT plus the agents' cycle, in one process. Needs DATABASE_URL in production.
CMD ["npx", "tsx", "scripts/serve.ts"]
