# Validation image for einvoice-ae: UBL 2.1 XSD plus the official PINT AE Schematron
# (compiled XSLT) executed with Saxon-HE. The artefacts are fetched and checksum-verified
# on the host first (npm run artefacts:fetch), so this build needs no network access.
#
# For local and CI use only: never push this image to a registry. It bundles third-party
# files under their own terms (docs/validation-artefacts.md), including the PINT AE
# artefacts, which may not be redistributed without OpenPEPPOL's consent, and the OASIS
# UBL schemas. Only Validator.java is this project's MIT-licensed code, so the image
# carries no licence label.

FROM eclipse-temurin:25-jdk-noble@sha256:2feab631bffce6236d8bb5261a4abe19a8d6f85bad1c01166f74686c983d011f AS build
WORKDIR /build
COPY .artefacts/lib/ lib/
COPY src/ src/
RUN javac -Xlint:all -Werror --release 21 -encoding UTF-8 -cp "lib/*" -d classes \
      src/main/java/ae/einvoice/validator/Validator.java

FROM eclipse-temurin:25-jre-noble@sha256:b573af9e331196fbc42e246da4df24df9b6c556c73e7efddfde0511f1c9508c5
LABEL org.opencontainers.image.title="einvoice-ae-validator" \
      org.opencontainers.image.description="UBL 2.1 XSD and PINT AE Schematron validation (Saxon-HE)" \
      org.opencontainers.image.source="https://github.com/fasharif/einvoice-ae"
COPY --from=build /build/classes /opt/einvoice-ae/classes
COPY .artefacts/lib/ /opt/einvoice-ae/lib/
COPY .artefacts/pint-ae/ /opt/einvoice-ae/artefacts/pint-ae/
COPY .artefacts/ubl/ /opt/einvoice-ae/artefacts/ubl/
COPY .artefacts/MANIFEST.json /opt/einvoice-ae/artefacts/MANIFEST.json
USER 10001:10001
WORKDIR /work
ENTRYPOINT ["java", "-XX:+UseSerialGC", "-XX:MaxRAMPercentage=75", "-Xss4m", \
            "-cp", "/opt/einvoice-ae/classes:/opt/einvoice-ae/lib/*", \
            "ae.einvoice.validator.Validator", "--artefacts", "/opt/einvoice-ae/artefacts"]
