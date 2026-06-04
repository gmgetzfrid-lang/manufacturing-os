package com.mfgos.mpp;

// Tiny stateless HTTP service that turns a Microsoft Project .mpp (or .mpx,
// .xml, P6 .xer — anything UniversalProjectReader handles) into the JSON the
// Manufacturing OS app expects (see lib/mppParser.ts tryRemoteConverter).
//
// Full fidelity via MPXJ: dependencies, resource assignments, user-defined
// custom columns (by their alias), exact dates, % complete, hierarchy.
//
// Deploy as a container; point the app's MPP_CONVERTER_URL at it. Scale-to-zero
// friendly (one POST = one parse). Optional bearer-token auth via
// MPP_CONVERTER_TOKEN (must match the app's env of the same name).

import com.google.gson.Gson;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import net.sf.mpxj.CustomField;
import net.sf.mpxj.Duration;
import net.sf.mpxj.FieldType;
import net.sf.mpxj.ProjectFile;
import net.sf.mpxj.Relation;
import net.sf.mpxj.Resource;
import net.sf.mpxj.ResourceAssignment;
import net.sf.mpxj.Task;
import net.sf.mpxj.TimeUnit;
import net.sf.mpxj.reader.UniversalProjectReader;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.AbstractMap;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Executors;

public class Server {
  private static final Gson GSON = new Gson();
  private static final String TOKEN = System.getenv("MPP_CONVERTER_TOKEN");

  public static void main(String[] args) throws IOException {
    int port = Integer.parseInt(System.getenv().getOrDefault("PORT", "8080"));
    HttpServer server = HttpServer.create(new InetSocketAddress(port), 0);
    server.createContext("/health", ex -> respond(ex, 200, "{\"ok\":true}"));
    server.createContext("/", Server::handle);
    server.setExecutor(Executors.newFixedThreadPool(4));
    server.start();
    System.out.println("mpp-converter listening on :" + port);
  }

  private static void handle(HttpExchange ex) throws IOException {
    try {
      if (!"POST".equalsIgnoreCase(ex.getRequestMethod())) {
        respond(ex, 405, "{\"error\":\"POST only\"}");
        return;
      }
      if (TOKEN != null && !TOKEN.isEmpty()) {
        String auth = ex.getRequestHeaders().getFirst("Authorization");
        if (auth == null || !auth.equals("Bearer " + TOKEN)) {
          respond(ex, 401, "{\"error\":\"unauthorized\"}");
          return;
        }
      }
      byte[] body = ex.getRequestBody().readAllBytes();
      if (body.length == 0) {
        respond(ex, 400, "{\"error\":\"empty body\"}");
        return;
      }
      respond(ex, 200, GSON.toJson(convert(body)));
    } catch (Exception e) {
      respond(ex, 500, GSON.toJson(Map.of("error", String.valueOf(e.getMessage()))));
    }
  }

  private static Map<String, Object> convert(byte[] bytes) throws Exception {
    ProjectFile project;
    try (InputStream in = new ByteArrayInputStream(bytes)) {
      project = new UniversalProjectReader().read(in);
    }
    if (project == null) throw new IOException("Unrecognized or unsupported project file");

    // User-defined custom columns: FieldType → the user's alias ("Contractor").
    List<Map.Entry<FieldType, String>> customFields = new ArrayList<>();
    try {
      for (CustomField cf : project.getCustomFields()) {
        FieldType ft = cf.getFieldType();
        String alias = cf.getAlias();
        if (ft != null && alias != null && !alias.isBlank()) {
          customFields.add(new AbstractMap.SimpleEntry<>(ft, alias));
        }
      }
    } catch (Throwable ignore) { /* custom fields are optional */ }

    List<Map<String, Object>> tasks = new ArrayList<>();
    for (Task t : project.getTasks()) {
      if (t == null) continue;
      try {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("uid", t.getUniqueID());
        Task parent = t.getParentTask();
        m.put("parentUid", parent != null ? parent.getUniqueID() : null);
        m.put("name", t.getName());
        m.put("start", iso(t.getStart()));
        m.put("finish", iso(t.getFinish()));
        m.put("outlineLevel", t.getOutlineLevel());
        m.put("wbs", t.getWBS());
        m.put("isSummary", t.getSummary());
        Number pct = t.getPercentageComplete();
        m.put("percentComplete", pct != null ? pct.intValue() : null);
        m.put("milestone", t.getMilestone());
        m.put("workHours", workHours(t.getWork(), project));
        m.put("notes", emptyToNull(t.getNotes()));

        // Resource assignments → comma-joined names.
        List<String> resNames = new ArrayList<>();
        for (ResourceAssignment ra : t.getResourceAssignments()) {
          Resource r = ra.getResource();
          if (r != null && r.getName() != null && !r.getName().isBlank()) resNames.add(r.getName());
        }
        m.put("resources", resNames.isEmpty() ? null : String.join(", ", resNames));

        // Predecessor links → list of predecessor task UIDs.
        List<Integer> preds = new ArrayList<>();
        for (Relation rel : t.getPredecessors()) {
          Task target = rel.getTargetTask();
          if (target != null && target.getUniqueID() != null) preds.add(target.getUniqueID());
        }
        m.put("predecessors", preds);

        // Custom column values keyed by the user's alias.
        Map<String, String> fields = new LinkedHashMap<>();
        for (Map.Entry<FieldType, String> cf : customFields) {
          Object v = t.get(cf.getKey());
          if (v != null && !String.valueOf(v).isBlank()) fields.put(cf.getValue(), String.valueOf(v));
        }
        m.put("fields", fields);

        tasks.add(m);
      } catch (Throwable perTask) { /* skip a malformed task, keep the rest */ }
    }

    Map<String, Object> out = new LinkedHashMap<>();
    out.put("projectName", project.getProjectProperties() != null ? project.getProjectProperties().getName() : null);
    out.put("tasks", tasks);
    return out;
  }

  private static String iso(Object d) {
    if (d == null) return null;
    if (d instanceof LocalDateTime ldt) return ldt.format(DateTimeFormatter.ISO_LOCAL_DATE_TIME);
    return d.toString();
  }

  private static Double workHours(Duration work, ProjectFile project) {
    if (work == null) return null;
    try {
      if (work.getUnits() == TimeUnit.HOURS) return work.getDuration();
      Duration h = Duration.convertUnits(work.getDuration(), work.getUnits(), TimeUnit.HOURS, project.getProjectProperties());
      return h != null ? h.getDuration() : null;
    } catch (Throwable t) {
      return null;
    }
  }

  private static String emptyToNull(String s) {
    return (s == null || s.isBlank()) ? null : s;
  }

  private static void respond(HttpExchange ex, int code, String json) throws IOException {
    byte[] b = json.getBytes(StandardCharsets.UTF_8);
    ex.getResponseHeaders().set("Content-Type", "application/json; charset=utf-8");
    ex.sendResponseHeaders(code, b.length);
    try (OutputStream os = ex.getResponseBody()) { os.write(b); }
  }
}
