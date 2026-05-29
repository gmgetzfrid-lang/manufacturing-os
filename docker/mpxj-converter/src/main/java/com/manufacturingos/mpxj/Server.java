// MPXJ HTTP wrapper for Manufacturing OS.
//
// Listens on $PORT (default 8080). POST a raw .mpp body to /
// and get back JSON: { projectName, tasks: [...] }.
//
// Wraps Apache MPXJ — the canonical open-source library for
// reading Microsoft Project files. Handles every MPP version
// (98, 2000, 2002, 2003, 2007, 2010, 2013, 2016, 2019, 365) plus
// MPX, MPT, MPP-Server, P6 XER/XML, GanttProject, Phoenix, and
// more — so this same endpoint can be used as a universal
// schedule-file parser if we ever generalize it.
//
// Auth: optional bearer token in $MPXJ_TOKEN. If set, requests
// must include "Authorization: Bearer <token>".
//
// The deliberately tiny footprint:
//   * No web framework. Uses the JDK's com.sun.net.httpserver.
//   * No JSON library. Emits JSON by hand — the shape is small
//     and stable, and it keeps the fat-jar lean.

package com.manufacturingos.mpxj;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import net.sf.mpxj.ProjectFile;
import net.sf.mpxj.Task;
import net.sf.mpxj.reader.UniversalProjectReader;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.time.LocalDateTime;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;

public class Server {
    public static void main(String[] args) throws Exception {
        int port = Integer.parseInt(System.getenv().getOrDefault("PORT", "8080"));
        HttpServer server = HttpServer.create(new InetSocketAddress(port), 0);
        server.createContext("/", Server::handle);
        server.setExecutor(null);
        System.out.println("[mpxj-converter] listening on :" + port);
        if (System.getenv("MPXJ_TOKEN") != null) {
            System.out.println("[mpxj-converter] bearer token required (MPXJ_TOKEN is set)");
        }
        server.start();
    }

    static void handle(HttpExchange ex) throws IOException {
        try {
            if ("GET".equals(ex.getRequestMethod())) {
                // Liveness probe.
                respond(ex, 200, "{\"ok\":true,\"service\":\"mpxj-converter\"}");
                return;
            }
            if (!"POST".equals(ex.getRequestMethod())) {
                respond(ex, 405, "{\"error\":\"method not allowed\"}");
                return;
            }
            String token = System.getenv("MPXJ_TOKEN");
            if (token != null && !token.isEmpty()) {
                String h = ex.getRequestHeaders().getFirst("Authorization");
                if (h == null || !h.equals("Bearer " + token)) {
                    respond(ex, 401, "{\"error\":\"unauthorized\"}");
                    return;
                }
            }

            ProjectFile project;
            try (InputStream is = ex.getRequestBody()) {
                project = new UniversalProjectReader().read(is);
            }

            if (project == null) {
                respond(ex, 422, "{\"error\":\"MPXJ couldn't recognize the uploaded file\"}");
                return;
            }

            StringBuilder json = new StringBuilder(8192);
            json.append("{");
            json.append("\"projectName\":").append(jsonEscape(safeName(project)));
            json.append(",\"tasks\":[");
            boolean first = true;
            for (Task t : project.getTasks()) {
                if (t == null || t.getName() == null || t.getName().isBlank()) continue;
                // Skip the project's root summary if MPXJ surfaces one.
                if (Boolean.TRUE.equals(t.getNull())) continue;
                if (!first) json.append(",");
                first = false;
                // Emit the real parent's unique id whenever a genuine
                // parent exists. The previous guard nulled the parent
                // when its *ID* was 0 — but the project-summary row
                // has ID 0, so EVERY top-level phase was orphaned and
                // rendered flat. Only treat a parent as absent when
                // MPXJ has no parent task at all (or it's the synthetic
                // null root MPXJ sometimes exposes).
                Task parent = t.getParentTask();
                Integer parentUid = (parent == null || Boolean.TRUE.equals(parent.getNull()))
                    ? null
                    : parent.getUniqueID();
                Integer outlineLevel = t.getOutlineLevel();
                String wbs = t.getWBS();
                Boolean isSummary = t.getSummary();
                json.append("{");
                json.append("\"uid\":").append(t.getUniqueID());
                json.append(",\"parentUid\":").append(parentUid == null ? "null" : parentUid.toString());
                json.append(",\"name\":").append(jsonEscape(t.getName()));
                json.append(",\"start\":").append(isoDate(t.getStart()));
                json.append(",\"finish\":").append(isoDate(t.getFinish()));
                json.append(",\"outlineLevel\":").append(outlineLevel == null ? "null" : outlineLevel.toString());
                json.append(",\"wbs\":").append(jsonEscape(wbs));
                json.append(",\"isSummary\":").append(isSummary == null ? "false" : isSummary.toString());
                Number pct = t.getPercentageComplete();
                json.append(",\"percentComplete\":").append(pct == null ? "null" : pct.toString());
                json.append(",\"milestone\":").append(t.getMilestone());
                json.append("}");
            }
            json.append("]}");
            respond(ex, 200, json.toString());
        } catch (Throwable t) {
            String msg = t.getClass().getSimpleName() + ": " + (t.getMessage() == null ? "" : t.getMessage());
            respond(ex, 500, "{\"error\":" + jsonEscape(msg) + "}");
        }
    }

    static void respond(HttpExchange ex, int status, String body) throws IOException {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        ex.getResponseHeaders().set("Content-Type", "application/json; charset=utf-8");
        ex.sendResponseHeaders(status, bytes.length);
        try (OutputStream os = ex.getResponseBody()) {
            os.write(bytes);
        }
    }

    static String jsonEscape(String s) {
        if (s == null) return "null";
        StringBuilder sb = new StringBuilder(s.length() + 2);
        sb.append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"':  sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                case '\t': sb.append("\\t"); break;
                default:
                    if (c < 0x20) sb.append(String.format("\\u%04x", (int) c));
                    else sb.append(c);
            }
        }
        sb.append('"');
        return sb.toString();
    }

    static String isoDate(LocalDateTime d) {
        if (d == null) return "null";
        return "\"" + d.atZone(ZoneOffset.UTC).format(DateTimeFormatter.ISO_INSTANT) + "\"";
    }

    static String safeName(ProjectFile p) {
        try { return p.getProjectProperties().getName(); }
        catch (Throwable t) { return null; }
    }
}
