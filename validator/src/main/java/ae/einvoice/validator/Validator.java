package ae.einvoice.validator;

import java.io.File;
import java.io.IOException;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.stream.Stream;
import javax.xml.XMLConstants;
import javax.xml.parsers.ParserConfigurationException;
import javax.xml.parsers.SAXParserFactory;
import javax.xml.transform.sax.SAXSource;
import javax.xml.transform.stream.StreamSource;
import javax.xml.validation.Schema;
import javax.xml.validation.SchemaFactory;
import net.sf.saxon.s9api.DocumentBuilder;
import net.sf.saxon.s9api.Processor;
import net.sf.saxon.s9api.QName;
import net.sf.saxon.s9api.SaxonApiException;
import net.sf.saxon.s9api.XPathCompiler;
import net.sf.saxon.s9api.XPathExecutable;
import net.sf.saxon.s9api.XPathSelector;
import net.sf.saxon.s9api.XdmDestination;
import net.sf.saxon.s9api.XdmItem;
import net.sf.saxon.s9api.XdmNode;
import net.sf.saxon.s9api.XdmNodeKind;
import net.sf.saxon.s9api.XsltCompiler;
import net.sf.saxon.s9api.XsltExecutable;
import net.sf.saxon.s9api.XsltTransformer;
import org.xml.sax.ErrorHandler;
import org.xml.sax.InputSource;
import org.xml.sax.SAXException;
import org.xml.sax.SAXParseException;
import org.xml.sax.XMLReader;

/**
 * Validates UBL 2.1 Invoice and CreditNote documents in two steps:
 *
 * <ol>
 *   <li>W3C XML Schema validation against the OASIS UBL 2.1 schemas (JAXP).
 *   <li>The two official PINT AE Schematron layers (PINT general rules and the UAE
 *       jurisdiction rules), executed from OpenPeppol's compiled XSLT with Saxon-HE.
 * </ol>
 *
 * <p>Prints one JSON document to standard output. Exit status: 0 when every document is
 * valid, 1 when at least one is invalid, 2 for usage or start-up errors.
 */
public final class Validator {

  private static final String SVRL_NS = "http://purl.oclc.org/dsdl/svrl";
  private static final String INVOICE_NS = "urn:oasis:names:specification:ubl:schema:xsd:Invoice-2";
  private static final String CREDIT_NOTE_NS =
      "urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2";

  /** One Schematron layer compiled once and reused for every document. */
  private record Layer(String name, XsltExecutable executable) {}

  private record XsdIssue(String severity, int line, int column, String message) {}

  private record Finding(String layer, String id, String flag, String location, String text) {}

  private record Result(
      String file,
      String documentType,
      String error,
      List<XsdIssue> xsd,
      List<Finding> schematron) {

    boolean valid() {
      return error == null
          && xsd.isEmpty()
          && schematron.stream().noneMatch(f -> "fatal".equals(f.flag()) || f.flag() == null);
    }
  }

  private final Processor processor = new Processor(false);
  private final Map<String, Schema> schemas = new LinkedHashMap<>();
  private final Map<String, List<Layer>> layers = new LinkedHashMap<>();
  private final XPathExecutable svrlFindings;

  private Validator(Path artefacts) throws SaxonApiException, SAXException {
    Path xsd = artefacts.resolve("ubl/xsd/maindoc");
    schemas.put("Invoice", loadSchema(xsd.resolve("UBL-Invoice-2.1.xsd")));
    schemas.put("CreditNote", loadSchema(xsd.resolve("UBL-CreditNote-2.1.xsd")));

    Path pint = artefacts.resolve("pint-ae");
    layers.put("Invoice", loadLayers(pint.resolve("trn-invoice/schematron")));
    layers.put("CreditNote", loadLayers(pint.resolve("trn-creditnote/schematron")));

    XPathCompiler xpath = processor.newXPathCompiler();
    xpath.declareNamespace("svrl", SVRL_NS);
    svrlFindings = xpath.compile("//svrl:failed-assert | //svrl:successful-report");
  }

  private static Schema loadSchema(Path file) throws SAXException {
    SchemaFactory factory = SchemaFactory.newInstance(XMLConstants.W3C_XML_SCHEMA_NS_URI);
    factory.setFeature(XMLConstants.FEATURE_SECURE_PROCESSING, true);
    // The UBL schemas import each other by relative file path; nothing else is allowed.
    factory.setProperty(XMLConstants.ACCESS_EXTERNAL_SCHEMA, "file");
    factory.setProperty(XMLConstants.ACCESS_EXTERNAL_DTD, "");
    return factory.newSchema(file.toFile());
  }

  private List<Layer> loadLayers(Path directory) throws SaxonApiException {
    XsltCompiler compiler = processor.newXsltCompiler();
    // The official stylesheets trigger Saxon style warnings (SXWN9032) that do not affect
    // the results; only real compilation errors are printed.
    compiler.setErrorReporter(error -> {
      if (!error.isWarning()) System.err.println("XSLT compilation error: " + error.getMessage());
    });
    List<Layer> result = new ArrayList<>();
    result.add(new Layer("pint", compile(compiler, directory.resolve("PINT-UBL-validation-preprocessed.xslt"))));
    result.add(new Layer("pint-ae", compile(compiler, directory.resolve("PINT-jurisdiction-aligned-rules.xslt"))));
    return result;
  }

  private static XsltExecutable compile(XsltCompiler compiler, Path file) throws SaxonApiException {
    return compiler.compile(new StreamSource(file.toFile()));
  }

  /** A namespace-aware SAX reader that refuses DOCTYPE declarations (no XXE). */
  private static XMLReader secureReader() throws SAXException {
    try {
      SAXParserFactory factory = SAXParserFactory.newInstance();
      factory.setNamespaceAware(true);
      factory.setFeature(XMLConstants.FEATURE_SECURE_PROCESSING, true);
      factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
      factory.setFeature("http://xml.org/sax/features/external-general-entities", false);
      factory.setFeature("http://xml.org/sax/features/external-parameter-entities", false);
      return factory.newSAXParser().getXMLReader();
    } catch (ParserConfigurationException e) {
      throw new SAXException("Cannot configure a secure XML parser", e);
    }
  }

  private static SAXSource secureSource(Path file) throws SAXException {
    return new SAXSource(secureReader(), new InputSource(file.toUri().toString()));
  }

  Result validate(Path file) {
    String name = file.toString().replace(File.separatorChar, '/');
    XdmNode document;
    try {
      DocumentBuilder builder = processor.newDocumentBuilder();
      builder.setLineNumbering(true);
      document = builder.build(secureSource(file));
    } catch (SaxonApiException | SAXException e) {
      return new Result(name, null, "Not well-formed XML: " + rootMessage(e), List.of(), List.of());
    }

    String documentType = documentType(document);
    if (documentType == null) {
      return new Result(name, null, "Root element must be a UBL 2.1 Invoice or CreditNote", List.of(), List.of());
    }

    List<XsdIssue> xsdIssues = validateSchema(file, schemas.get(documentType));
    List<Finding> findings = new ArrayList<>();
    for (Layer layer : layers.get(documentType)) {
      try {
        findings.addAll(runLayer(layer, document));
      } catch (SaxonApiException e) {
        return new Result(name, documentType, "Schematron layer " + layer.name() + " failed: " + rootMessage(e), xsdIssues, findings);
      }
    }
    return new Result(name, documentType, null, xsdIssues, findings);
  }

  private static String documentType(XdmNode document) {
    for (XdmNode child : document.children()) {
      if (child.getNodeKind() != XdmNodeKind.ELEMENT) continue;
      QName root = child.getNodeName();
      if (INVOICE_NS.equals(root.getNamespace()) && "Invoice".equals(root.getLocalName())) return "Invoice";
      if (CREDIT_NOTE_NS.equals(root.getNamespace()) && "CreditNote".equals(root.getLocalName())) return "CreditNote";
      return null;
    }
    return null;
  }

  private static List<XsdIssue> validateSchema(Path file, Schema schema) {
    List<XsdIssue> issues = new ArrayList<>();
    javax.xml.validation.Validator validator = schema.newValidator();
    try {
      validator.setProperty(XMLConstants.ACCESS_EXTERNAL_DTD, "");
      validator.setProperty(XMLConstants.ACCESS_EXTERNAL_SCHEMA, "");
    } catch (SAXException e) {
      issues.add(new XsdIssue("error", 0, 0, "Cannot secure the schema validator: " + e.getMessage()));
      return issues;
    }
    validator.setErrorHandler(new ErrorHandler() {
      @Override
      public void warning(SAXParseException e) {
        // Schema warnings do not make a document invalid; they are not reported.
      }

      @Override
      public void error(SAXParseException e) {
        issues.add(new XsdIssue("error", e.getLineNumber(), e.getColumnNumber(), e.getMessage()));
      }

      @Override
      public void fatalError(SAXParseException e) {
        issues.add(new XsdIssue("fatal", e.getLineNumber(), e.getColumnNumber(), e.getMessage()));
      }
    });
    try {
      validator.validate(secureSource(file));
    } catch (SAXException | IOException e) {
      if (issues.isEmpty()) issues.add(new XsdIssue("fatal", 0, 0, rootMessage(e)));
    }
    return issues;
  }

  private List<Finding> runLayer(Layer layer, XdmNode document) throws SaxonApiException {
    XsltTransformer transformer = layer.executable().load();
    transformer.setInitialContextNode(document);
    XdmDestination svrl = new XdmDestination();
    transformer.setDestination(svrl);
    transformer.transform();

    XPathSelector selector = svrlFindings.load();
    selector.setContextItem(svrl.getXdmNode());
    List<Finding> findings = new ArrayList<>();
    for (XdmItem item : selector) {
      XdmNode node = (XdmNode) item;
      String text = "";
      for (XdmNode child : node.children()) {
        if (child.getNodeKind() == XdmNodeKind.ELEMENT && "text".equals(child.getNodeName().getLocalName())) {
          text = child.getStringValue().replaceAll("\\s+", " ").trim();
        }
      }
      findings.add(new Finding(
          layer.name(),
          node.getAttributeValue(new QName("id")),
          node.getAttributeValue(new QName("flag")),
          node.getAttributeValue(new QName("location")),
          text));
    }
    return findings;
  }

  private static String rootMessage(Throwable error) {
    Throwable current = error;
    while (current.getCause() != null && current.getCause() != current) current = current.getCause();
    String message = current.getMessage();
    return message == null ? current.getClass().getSimpleName() : message;
  }

  // ---------------------------------------------------------------- JSON output

  private static String json(String value) {
    if (value == null) return "null";
    StringBuilder out = new StringBuilder(value.length() + 2).append('"');
    for (int i = 0; i < value.length(); i++) {
      char c = value.charAt(i);
      switch (c) {
        case '"' -> out.append("\\\"");
        case '\\' -> out.append("\\\\");
        case '\n' -> out.append("\\n");
        case '\r' -> out.append("\\r");
        case '\t' -> out.append("\\t");
        default -> {
          if (c < 0x20) out.append(String.format(Locale.ROOT, "\\u%04x", (int) c));
          else out.append(c);
        }
      }
    }
    return out.append('"').toString();
  }

  private static String toJson(Result r) {
    StringBuilder out = new StringBuilder();
    out.append("{\"file\":").append(json(r.file()))
        .append(",\"documentType\":").append(json(r.documentType()))
        .append(",\"valid\":").append(r.valid())
        .append(",\"error\":").append(json(r.error()))
        .append(",\"xsd\":[");
    for (int i = 0; i < r.xsd().size(); i++) {
      XsdIssue x = r.xsd().get(i);
      if (i > 0) out.append(',');
      out.append("{\"severity\":").append(json(x.severity()))
          .append(",\"line\":").append(x.line())
          .append(",\"column\":").append(x.column())
          .append(",\"message\":").append(json(x.message())).append('}');
    }
    out.append("],\"schematron\":[");
    for (int i = 0; i < r.schematron().size(); i++) {
      Finding f = r.schematron().get(i);
      if (i > 0) out.append(',');
      out.append("{\"layer\":").append(json(f.layer()))
          .append(",\"id\":").append(json(f.id()))
          .append(",\"flag\":").append(json(f.flag()))
          .append(",\"location\":").append(json(f.location()))
          .append(",\"text\":").append(json(f.text())).append('}');
    }
    return out.append("]}").toString();
  }

  // ---------------------------------------------------------------- command line

  private static List<Path> collect(List<String> arguments) throws IOException {
    List<Path> files = new ArrayList<>();
    for (String argument : arguments) {
      Path path = Path.of(argument);
      if (Files.isDirectory(path)) {
        try (Stream<Path> walk = Files.walk(path)) {
          walk.filter(p -> Files.isRegularFile(p) && p.toString().endsWith(".xml")).sorted().forEach(files::add);
        }
      } else if (Files.isRegularFile(path)) {
        files.add(path);
      } else {
        throw new IOException("No such file or directory: " + argument);
      }
    }
    return files;
  }

  private static void usage(PrintStream out) {
    out.println("Usage: validate [--artefacts DIR] FILE_OR_DIRECTORY...");
    out.println("Validates UBL 2.1 Invoice/CreditNote XML against the UBL 2.1 XSD and the");
    out.println("official PINT AE Schematron rules. Prints JSON to standard output.");
  }

  public static void main(String[] args) {
    Path artefacts = Path.of("/opt/einvoice-ae/artefacts");
    List<String> inputs = new ArrayList<>();
    for (int i = 0; i < args.length; i++) {
      switch (args[i]) {
        case "--artefacts" -> {
          if (i + 1 >= args.length) {
            usage(System.err);
            System.exit(2);
          }
          artefacts = Path.of(args[++i]);
        }
        case "-h", "--help" -> {
          usage(System.out);
          System.exit(0);
        }
        default -> inputs.add(args[i]);
      }
    }
    if (inputs.isEmpty()) {
      usage(System.err);
      System.exit(2);
    }

    List<Path> files;
    Validator validator;
    try {
      files = collect(inputs);
      validator = new Validator(artefacts);
    } catch (IOException | SaxonApiException | SAXException e) {
      System.err.println("Validator start-up failed: " + rootMessage(e));
      System.exit(2);
      return;
    }

    PrintStream out = new PrintStream(System.out, false, StandardCharsets.UTF_8);
    boolean allValid = true;
    out.print("{\"engine\":{\"saxon\":");
    out.print(json(validator.processor.getSaxonProductVersion()));
    out.print(",\"java\":");
    out.print(json(System.getProperty("java.version")));
    out.print("},\"results\":[");
    for (int i = 0; i < files.size(); i++) {
      Result result = validator.validate(files.get(i));
      allValid &= result.valid();
      if (i > 0) out.print(',');
      out.print(toJson(result));
    }
    out.println("]}");
    out.flush();
    System.exit(allValid ? 0 : 1);
  }
}
