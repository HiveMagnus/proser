FROM mcr.microsoft.com/dotnet/sdk:8.0-bookworm-slim@sha256:78235e09001f52b6592c458ac010775ebac6725422e80cd0c1650590f67b2743
ENV DOTNET_CLI_TELEMETRY_OPTOUT=1
RUN apt-get update && apt-get install -y --no-install-recommends libreoffice-writer poppler-utils qpdf epubcheck bzip2 python3 \
    && rm -rf /var/lib/apt/lists/*
COPY install-fonts.sh /opt/install-fonts.sh
RUN /bin/bash /opt/install-fonts.sh
WORKDIR /validator
COPY validator/ ./
RUN dotnet restore --locked-mode && dotnet publish --no-restore --configuration Release --output /opt/validator
COPY render-docx.sh /opt/render-docx.sh
COPY verify-fixtures.sh /opt/verify-fixtures.sh
COPY verify-native-paragraphs.sh /opt/verify-native-paragraphs.sh
COPY verify-owned-stories.sh /opt/verify-owned-stories.sh
COPY verify-story-rasters.py /opt/verify-story-rasters.py
COPY verify-native-comments.sh /opt/verify-native-comments.sh
COPY verify-historical-boundaries.sh /opt/verify-historical-boundaries.sh
COPY verify-named-styles.sh /opt/verify-named-styles.sh
COPY verify-themes-webp.sh /opt/verify-themes-webp.sh
COPY verify-large-paragraph.sh /opt/verify-large-paragraph.sh
COPY verify-empty-line-fonts.sh /opt/verify-empty-line-fonts.sh
WORKDIR /fixtures
CMD ["dotnet", "/opt/validator/Validator.dll"]
