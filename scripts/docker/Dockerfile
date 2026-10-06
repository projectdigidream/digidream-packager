# The toolchain that builds the Linux and Windows game servers for the kits.
#
# Ubuntu 22.04 ON PURPOSE: a Linux binary runs on any glibc at least as new as
# the one it was linked against, so the OLDEST still-maintained base wins.
# glibc 2.35 here means Ubuntu 22.04+, Debian 12+, Fedora 36+. (Debian bullseye,
# glibc 2.31, was tried first: its packages have left the main mirrors.)
FROM ubuntu:22.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      clang make ca-certificates \
      g++-mingw-w64-x86-64 binutils-mingw-w64-x86-64 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /work
