
# # 
# # hmd-docker-local/docker-ansible
# #
# # Built with Alpine Linux
# ##################
# # Set Build Args #
# ##################
ARG LABEL_MAINTAINER="ceso-isg-platengr@globe.com.ph"
ARG LABEL_VERSION="v2.0.1"
ARG JFROG_URL="globe.pe.jfrog.io"
ARG JFROG_REPO="hmd-docker-virtual"
ARG BASE_IMAGE="node:22-alpine"
FROM ${JFROG_URL}/${JFROG_REPO}/${BASE_IMAGE} as Builder

###############
# Build Setup #
###############
# Inherit Build Args
ARG JFROG_USERNAME
ARG JFROG_PASSWORD
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
RUN echo "https://$JFROG_USERNAME:$JFROG_PASSWORD@$ARTIFACTORY_URL/artifactory/hmd-alpinelinux/v3.19/main" >> /etc/apk/repositories
RUN echo "https://$JFROG_USERNAME:$JFROG_PASSWORD@$ARTIFACTORY_URL/artifactory/hmd-alpinelinux/v3.19/community" >> /etc/apk/repositories
RUN echo "https://$JFROG_USERNAME:$JFROG_PASSWORD@$ARTIFACTORY_URL/artifactory/hmd-alpinelinux/edge/community" >> /etc/apk/repositories

# RUN mkdir ~/.pip && touch ~/.pip/pip.conf
# RUN echo -e "\
# [global] \n\
# index-url = https://$JFROG_USERNAME:$JFROG_PASSWORD@$ARTIFACTORY_URL/artifactory/api/pypi/hmd-python-virtual/simple" \
# > ~/.pip/pip.conf

# Set environment variables
ENV VIRTUAL_ENV=/venv
ENV PATH="$VIRTUAL_ENV/bin:$PATH"

# # Install system dependencies
RUN apk update && apk add --no-cache \
     bash
#     openssh 9.8_p1-r0\
#     openssl

# Set the working directory
WORKDIR /app

USER node 

COPY . .

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

#ENV NPM_CONFIG_REGISTRY=https://$JFROG_USERNAME:$JFROG_PASSWORD@$ARTIFACTORY_URL/artifactory/api/npm/hmd-npm-virtual
#RUN npm install --verbose
#RUN npm list

# Set the environment to production
ENV NODE_ENV=production

#Build the typescript files
RUN npm run build --verbose

# Step 2: Create a smaller runtime image
FROM Builder as Runner

# Set working directory
WORKDIR /app

# Copy only the built files and necessary dependencies from the builder
COPY --from=Builder /app ./

# Expose the port your app runs on
EXPOSE 3001

# Command to start the application
CMD ["npm", "run", "start"]
