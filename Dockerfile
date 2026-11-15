# Base image pinned by digest; Dependabot proposes updates.
FROM node:26-slim@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:26-slim@sha256:e6bedef217677b276c591795e169840edd9096dbf13f29df8ef8d1856b8820bc
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY --from=builder /app/build ./build
# Remove setuid/setgid bits (su, passwd, mount, ...), so nothing in the image
# can raise privileges even without --security-opt=no-new-privileges.
RUN find / -xdev -perm /6000 -type f -exec chmod a-s {} +
# Run as the base image's unprivileged "node" user (UID 1000). The app files
# stay owned by root, so the server can read them but not change them.
USER node
ENTRYPOINT ["node", "build/index.js"]
