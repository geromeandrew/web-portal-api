
# #
# # hmd-docker-local/docker-ansible
# #
# # Built with Alpine Linux
# ##################
# # Set Build Args #
# ##################
ARG LABEL_MAINTAINER="ceso-isg-platengr@globe.com.ph"
ARG LABEL_VERSION="v3.0.0"
ARG JFROG_URL="globe.pe.jfrog.io"
ARG JFROG_REPO="hmd-docker-virtual"
ARG BASE_IMAGE="node:24.22.1-alpine"
FROM ${JFROG_URL}/${JFROG_REPO}/${BASE_IMAGE} as Builder

###############
# Build Setup #
###############
# Inherit Build Args
ARG JFROG_USERNAME
ARG JFROG_PASSWORD
ARG JFROG_ACCESS_TOKEN
ARG ARTIFACTORY_URL
ARG PE_JFROG_ACCESS_TOKEN
ARG LABEL_MAINTAINER
ARG LABEL_VERSION
ARG PE_JFROG_URL
ARG PE_JFROG_REPO

# # Setup Docker Labels
# LABEL maintainer=$LABEL_MAINTAINER
# LABEL version=$LABEL_VERSION

USER root

# clear alpine repos
RUN cp /dev/null /etc/apk/repositories
# add JFrog as primary alpine repos
RUN echo "https://$JFROG_USERNAME:$JFROG_PASSWORD@$ARTIFACTORY_URL/artifactory/hmd-alpinelinux/v3.21/main" >> /etc/apk/repositories
RUN echo "https://$JFROG_USERNAME:$JFROG_PASSWORD@$ARTIFACTORY_URL/artifactory/hmd-alpinelinux/v3.21/community" >> /etc/apk/repositories
RUN echo "https://$JFROG_USERNAME:$JFROG_PASSWORD@$ARTIFACTORY_URL/artifactory/hmd-alpinelinux/edge/community" >> /etc/apk/repositories


# Set environment variables
ENV VIRTUAL_ENV=/venv
ENV PATH="$VIRTUAL_ENV/bin:$PATH"

# # Install system dependencies
RUN apk update && apk add --no-cache \
     bash\
     openssh\
     openssl
RUN apk add --no-cache python3 py3-pip

# Set the working directory
WORKDIR /app

COPY . .
RUN python3 -m venv /app/.venv-prepaid && /app/.venv-prepaid/bin/pip install --no-cache-dir -r infrastructure/prepaid/requirements-backend.txt

# Step 1: Generate Base64 auth and write directly to .npmrc to avoid CLI parsing errors
RUN AUTH_BASE64=$(printf "%s:%s" "$JFROG_USERNAME" "$JFROG_PASSWORD" | base64 | tr -d '\n') && \
    echo "registry=https://${ARTIFACTORY_URL}/artifactory/api/npm/hmd-npm-virtual/" > ~/.npmrc && \
    echo "//${ARTIFACTORY_URL}/artifactory/api/npm/hmd-npm-virtual/:_auth=${AUTH_BASE64}" >> ~/.npmrc && \
    echo "always-auth=true" >> ~/.npmrc

RUN npm install --global pnpm@10.30.2 && pnpm install --frozen-lockfile

# Set the environment to production
ENV NODE_ENV=production

#Build the typescript files
RUN npm run build

# Strip credentials out before finalizing this stage
RUN rm -f ~/.npmrc


# Prune only after compilation. Build credentials and source remain in builder stages.
FROM Builder AS ProductionDependencies
RUN pnpm prune --prod

# Fresh runtime: no build registry configuration, credentials or development tools.
FROM ${JFROG_URL}/${JFROG_REPO}/${BASE_IMAGE} AS Runner
WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache python3
COPY --from=ProductionDependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=Builder --chown=node:node /app/dist ./dist
COPY --from=Builder --chown=node:node /app/package.json ./package.json
COPY --from=Builder --chown=node:node /app/.venv-prepaid ./.venv-prepaid
COPY --from=Builder --chown=node:node /app/infrastructure/prepaid ./infrastructure/prepaid
USER node
EXPOSE 3001
CMD ["node", "dist/index.js"]
