# ==========================================
# STAGE 1: DEPENDENCIES
# ==========================================
ARG JFROG_USERNAME
ARG JFROG_ACCESS_TOKEN
ARG LABEL_MAINTAINER="ceso-isg-platengr@globe.com.ph"
ARG LABEL_VERSION="v3.0.0"
ARG JFROG_URL="globe.pe.jfrog.io"
ARG JFROG_REPO="hmd-docker-virtual"
ARG BASE_IMAGE="node:22.14.0-alpine"

FROM ${JFROG_URL}/${JFROG_REPO}/${BASE_IMAGE} AS deps

# Inherit Build Args
ARG JFROG_USERNAME
ARG JFROG_ACCESS_TOKEN
ARG JFROG_URL

USER root

# Add JFrog as primary alpine repos.
# The single '>' overwrites default repos, '>>' appends the community repo.
RUN echo "https://${JFROG_USERNAME}:${JFROG_ACCESS_TOKEN}@${JFROG_URL}/artifactory/hmd-alpinelinux/v3.21/main" > /etc/apk/repositories && \
    echo "https://${JFROG_USERNAME}:${JFROG_ACCESS_TOKEN}@${JFROG_URL}/artifactory/hmd-alpinelinux/v3.21/community" >> /etc/apk/repositories

# Install essential tools
RUN apk update && apk add --no-cache \
    curl \
    bash 

# Set the working directory
WORKDIR /app

# Change ownership of the workspace to 'node' before switching
RUN chown -R node:node /app

# Switch to the non-privileged 'node' user
USER node

# Copy manifest files with correct ownership
COPY --chown=node:node package*.json ./

# Dependency Installation
# Authenticate using the 'node' user's home directory (~)
RUN echo "registry=https://${JFROG_URL}/artifactory/api/npm/hmd-npm-virtual" > ~/.npmrc && \
    curl -u ${JFROG_USERNAME}:${JFROG_ACCESS_TOKEN} https://$JFROG_URL/artifactory/api/npm/auth/ | \
    sed "s,_auth = ,//${JFROG_URL}/artifactory/api/npm/hmd-npm-virtual/:_auth=\",g" | \
    sed '1 s/$/"/' >> ~/.npmrc

# Install dependencies using Clean Install
RUN npm ci --loglevel verbose

# Copy the rest of the application code
COPY --chown=node:node . .

# Clean up credentials from the build stage
RUN rm -f ~/.npmrc

# ==========================================
# STAGE 2: PRODUCTION RUNTIME (Token-Free)
# ==========================================
FROM ${JFROG_URL}/${JFROG_REPO}/${BASE_IMAGE} AS production

ARG LABEL_MAINTAINER
ARG LABEL_VERSION

LABEL maintainer=$LABEL_MAINTAINER
LABEL version=$LABEL_VERSION

# Re-install runtime tools
USER root
RUN apk update && apk add --no-cache \
    curl \
    bash 

WORKDIR /app

# Only copy the built artifacts and dependencies from the previous stage
COPY --chown=node:node --from=deps /app/package*.json ./
COPY --chown=node:node --from=deps /app/node_modules ./node_modules

# Copy application code
COPY --chown=node:node --from=deps /app/src ./src

# Expose port for this container
EXPOSE 3001

USER node

# Command to run your application
CMD ["npm", "start"]
