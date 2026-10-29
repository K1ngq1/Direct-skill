"""Patch XLSX values without reserializing workbook formatting or attachments."""

import base64
import binascii
import hashlib
import io
import json
import math
import os
from pathlib import Path
import posixpath
import re
import struct
import sys
from urllib.parse import unquote, urlsplit
from xml.parsers import expat
from xml.sax.saxutils import escape
import zipfile


MAIN_NAMESPACES = {
    "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
    "http://purl.oclc.org/ooxml/spreadsheetml/main",
}
CELL = re.compile(r"([A-Z]{1,3})([1-9][0-9]{0,6})\Z")
ATTRIBUTE = re.compile(rb"""(\s+)([^\s=/>]+)(\s*=\s*)(["'])(.*?)\4""", re.S)
REL_NAMESPACE = "http://schemas.openxmlformats.org/package/2006/relationships"
OFFICE_REL_NAMESPACE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
DRAWING_NAMESPACE = "http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"
DRAWING_MAIN_NAMESPACE = "http://schemas.openxmlformats.org/drawingml/2006/main"


class PatchError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def require(condition, code, message):
    if not condition:
        raise PatchError(code, message)


def coordinate(reference):
    match = CELL.fullmatch(reference) if isinstance(reference, str) else None
    require(match, "INVALID_CELL", f"Invalid cell reference: {reference!r}")
    column = 0
    for letter in match[1]:
        column = column * 26 + ord(letter) - 64
    row = int(match[2])
    require(column <= 16384 and row <= 1048576, "INVALID_CELL", f"Cell outside Excel limits: {reference}")
    return row, column


def tag_end(data, start):
    quote = None
    for index in range(start, len(data)):
        char = data[index]
        if quote:
            if char == quote:
                quote = None
        elif char in (34, 39):
            quote = char
        elif char == 62:
            return index + 1
    raise PatchError("INVALID_XML", "Unclosed XML tag")


def parse_xml(data):
    # Expat supplies byte offsets; keeping the original bytes preserves prefixes and extensions.
    try:
        data.decode("utf-8-sig")
    except UnicodeDecodeError as error:
        raise PatchError("INVALID_XML", "Only UTF-8 XLSX XML is supported") from error
    declaration = re.match(rb'(?:\xef\xbb\xbf)?<\?xml\s+[^?]*\?>', data)
    encoding = re.search(rb"""encoding\s*=\s*(["'])(.*?)\1""", declaration[0]) if declaration else None
    require(not encoding or encoding[2].lower().replace(b"-", b"") == b"utf8",
            "INVALID_XML", "Only UTF-8 XLSX XML is supported")
    parser = expat.ParserCreate(namespace_separator="}")
    stack, roots = [], []

    def start(name, attrs):
        offset = parser.CurrentByteIndex
        end = tag_end(data, offset)
        raw = data[offset:end]
        node = {"tag": name, "attrs": attrs, "start": offset, "openEnd": end,
                "empty": raw.rstrip().endswith(b"/>"), "children": [], "text": "",
                "qname": re.match(rb"<([^\s/>]+)", raw)[1]}
        (stack[-1]["children"] if stack else roots).append(node)
        stack.append(node)

    def end(_name):
        node = stack.pop()
        node["closeStart"] = node["openEnd"] if node["empty"] else parser.CurrentByteIndex
        node["end"] = node["openEnd"] if node["empty"] else tag_end(data, parser.CurrentByteIndex)

    def reject_doctype(*_args):
        raise PatchError("INVALID_XML", "DTD and entity declarations are not supported")

    def text(value):
        if stack:
            stack[-1]["text"] += value

    parser.StartElementHandler = start
    parser.EndElementHandler = end
    parser.CharacterDataHandler = text
    parser.StartDoctypeDeclHandler = reject_doctype
    parser.EntityDeclHandler = reject_doctype
    try:
        parser.Parse(data, True)
    except expat.ExpatError as error:
        raise PatchError("INVALID_XML", str(error)) from error
    require(len(roots) == 1, "INVALID_XML", "Expected one XML root")
    return roots[0]


def apply_edits(data, edits):
    parts, cursor = [], 0
    for start, end, replacement in sorted(edits, key=lambda edit: (edit[0], edit[1])):
        require(start >= cursor, "INVALID_XML", "Overlapping XML edits")
        parts.extend((data[cursor:start], replacement))
        cursor = end
    parts.append(data[cursor:])
    return b"".join(parts)


def value_xml(value, prefix):
    def element(name, text, attributes=""):
        qualified = prefix + name.encode("ascii")
        return b"<" + qualified + attributes.encode("ascii") + b">" + text + b"</" + qualified + b">"

    if value is None:
        return None, b""
    if isinstance(value, bool):
        return b"b", element("v", b"1" if value else b"0")
    if isinstance(value, (int, float)):
        require(not isinstance(value, float) or math.isfinite(value), "INVALID_VALUE", "Numbers must be finite")
        return None, element("v", json.dumps(value, allow_nan=False).encode("ascii"))
    require(isinstance(value, str), "INVALID_VALUE", "Values must be string, finite number, boolean or null")
    require(all(char in "\t\n\r" or 0x20 <= ord(char) <= 0xD7FF
                or 0xE000 <= ord(char) <= 0xFFFD or 0x10000 <= ord(char) <= 0x10FFFF
                for char in value), "INVALID_VALUE", "Text contains an invalid XML character")
    value = re.sub(r"_x[0-9a-fA-F]{4}_", lambda match: "_x005F_" + match[0][1:], value)
    text = escape(value).replace("\r", "&#13;").encode("utf-8")
    return b"inlineStr", element("is", element("t", text, ' xml:space="preserve"'))


def opening_type(opening, value_type):
    name_end = re.match(rb"<[^\s/>]+", opening).end()
    for match in ATTRIBUTE.finditer(opening, name_end):
        if match[2] == b"t":
            if value_type is None:
                return opening[:match.start()] + opening[match.end():]
            return opening[:match.start(5)] + value_type + opening[match.end(5):]
    if value_type is None:
        return opening
    position = len(opening) - (2 if opening.endswith(b"/>") else 1)
    return opening[:position] + b' t="' + value_type + b'"' + opening[position:]


def patch_cell(data, node, value, namespace):
    children = node["children"]
    require(not any(child["tag"] == namespace + "}f" for child in children),
            "FORMULA_CELL", f"Refusing formula cell: {node['attrs'].get('r')}")
    qname = node["qname"]
    prefix = qname[:-1] if qname.endswith(b":c") else b""
    value_type, body = value_xml(value, prefix)
    opening = opening_type(data[node["start"]:node["openEnd"]], value_type)
    if node["empty"]:
        return opening[:-2] + b">" + body + b"</" + qname + b">" if body else opening
    values = [child for child in children if child["tag"] in (namespace + "}v", namespace + "}is")]
    changes = [(node["start"], node["openEnd"], opening)]
    for index, child in enumerate(values):
        changes.append((child["start"], child["end"], body if index == 0 else b""))
    if not values and body:
        position = next((child["start"] for child in children if child["tag"] == namespace + "}extLst"), node["closeStart"])
        changes.append((position, position, body))
    return apply_edits(data[node["start"]:node["end"]],
                       [(start - node["start"], end - node["start"], content) for start, end, content in changes])


def patch_sheet(data, updates):
    root = parse_xml(data)
    namespace = root["tag"].rsplit("}", 1)[0]
    require(namespace in MAIN_NAMESPACES and root["tag"] == namespace + "}worksheet",
            "INVALID_WORKSHEET", "Expected a spreadsheet worksheet")
    tag = lambda name: namespace + "}" + name
    sheet_data = next((node for node in root["children"] if node["tag"] == tag("sheetData")), None)
    require(sheet_data, "INVALID_WORKSHEET", "Missing sheetData")
    rows = {}
    for row in sheet_data["children"]:
        if row["tag"] == tag("row"):
            number = row["attrs"].get("r", "")
            require(number.isdigit() and int(number) not in rows, "INVALID_WORKSHEET", "Missing or duplicate row number")
            rows[int(number)] = row
    merged = []
    for container in root["children"]:
        if container["tag"] == tag("mergeCells"):
            for merge in container["children"]:
                if merge["tag"] == tag("mergeCell"):
                    references = merge["attrs"].get("ref", "").split(":")
                    require(1 <= len(references) <= 2, "INVALID_WORKSHEET", "Invalid merged range")
                    merged.append((coordinate(references[0]), coordinate(references[-1])))
    edits, insertions, empty_rows = [], {}, {}
    for update in sorted(updates, key=lambda item: coordinate(item["cell"])):
        reference, value = update["cell"], update["value"]
        row_number, column = coordinate(reference)
        for first, last in merged:
            require(not (first[0] <= row_number <= last[0] and first[1] <= column <= last[1]) or (row_number, column) == first,
                    "MERGED_CELL", f"Refusing non-anchor merged cell: {reference}")
        require(row_number in rows, "MISSING_ROW", f"Row does not exist: {row_number}")
        row = rows[row_number]
        cells = [node for node in row["children"] if node["tag"] == tag("c")]
        references = [node["attrs"].get("r") for node in cells]
        require(len(set(references)) == len(references), "INVALID_WORKSHEET", "Duplicate worksheet cell")
        for existing in references:
            require(coordinate(existing)[0] == row_number, "INVALID_WORKSHEET", "Cell and row references disagree")
        node = next((node for node in cells if node["attrs"].get("r") == reference), None)
        if node:
            edits.append((node["start"], node["end"], patch_cell(data, node, value, namespace)))
        elif value is not None:
            prefix = row["qname"][:-3] if row["qname"].endswith(b":row") else b""
            value_type, body = value_xml(value, prefix)
            qname = prefix + b"c"
            opening = b"<" + qname + b' r="' + reference.encode("ascii") + b'">'
            content = opening_type(opening, value_type) + body + b"</" + qname + b">"
            if row["empty"]:
                empty_rows.setdefault(row_number, []).append(content)
            else:
                position = next((cell["start"] for cell in cells if coordinate(cell["attrs"]["r"])[1] > column), row["closeStart"])
                insertions.setdefault(position, []).append(content)
    edits.extend((position, position, b"".join(content)) for position, content in insertions.items())
    for number, content in empty_rows.items():
        row = rows[number]
        opening = data[row["start"]:row["openEnd"]]
        edits.append((row["start"], row["end"], opening[:-2] + b">" + b"".join(content) + b"</" + row["qname"] + b">"))
    patched = apply_edits(data, edits)
    parse_xml(patched)
    return patched


def sheet_paths(archive):
    workbook = parse_xml(archive.read("xl/workbook.xml"))
    namespace = workbook["tag"].rsplit("}", 1)[0]
    require(namespace in MAIN_NAMESPACES and workbook["tag"] == namespace + "}workbook",
            "INVALID_WORKBOOK", "Expected spreadsheet workbook.xml")
    relations = parse_xml(archive.read("xl/_rels/workbook.xml.rels"))
    links = {}
    for relation in relations["children"]:
        attrs = relation["attrs"]
        if relation["tag"].endswith("}Relationship"):
            require(attrs.get("Id") not in links, "INVALID_WORKBOOK", "Duplicate workbook relationship")
            links[attrs.get("Id")] = attrs
    sheets = {}
    for container in workbook["children"]:
        if container["tag"] != namespace + "}sheets":
            continue
        for sheet in container["children"]:
            if sheet["tag"] != namespace + "}sheet":
                continue
            name = sheet["attrs"].get("name")
            require(name and name not in sheets, "INVALID_WORKBOOK", "Missing or duplicate worksheet name")
            rel_id = next((value for key, value in sheet["attrs"].items() if key.endswith("/relationships}id")), None)
            link = links.get(rel_id, {})
            target = unquote(link.get("Target", ""))
            require(link.get("TargetMode") != "External" and link.get("Type", "").endswith("/worksheet")
                    and target and "\\" not in target and "?" not in target and "#" not in target,
                    "INVALID_WORKBOOK", f"Unsupported worksheet relationship: {name}")
            target = posixpath.normpath(target.lstrip("/") if target.startswith("/") else posixpath.join("xl", target))
            require(not target.startswith("../") and target in archive.namelist(), "INVALID_WORKBOOK", f"Missing worksheet part: {name}")
            sheets[name] = target
    return sheets


def descendants(node):
    yield node
    for child in node["children"]:
        yield from descendants(child)


def xml_attribute(value):
    return escape(value, {'"': "&quot;", "'": "&apos;"}).encode("utf-8")


def qualified(node, local):
    prefix = node["qname"].rsplit(b":", 1)[0] + b":" if b":" in node["qname"] else b""
    return prefix + local.encode("ascii")


def append_xml(data, node, child):
    if node["empty"]:
        replacement = data[node["start"]:node["openEnd"] - 2] + b">" + child + b"</" + node["qname"] + b">"
        return apply_edits(data, [(node["start"], node["end"], replacement)])
    return apply_edits(data, [(node["closeStart"], node["closeStart"], child)])


def replace_attribute(data, node, name, value):
    opening = data[node["start"]:node["openEnd"]]
    for match in ATTRIBUTE.finditer(opening, re.match(rb"<[^\s/>]+", opening).end()):
        if match[2] == name.encode("ascii"):
            return apply_edits(data, [(node["start"] + match.start(5), node["start"] + match.end(5), xml_attribute(value))])
    raise PatchError("INVALID_XML", f"Missing XML attribute: {name}")


def rels_path(part):
    return posixpath.join(posixpath.dirname(part), "_rels", posixpath.basename(part) + ".rels")


def linked_part(owner, target):
    target = unquote(target)
    require(target and "\\" not in target and "?" not in target and "#" not in target
            and not urlsplit(target).scheme, "INVALID_RELATIONSHIP", "Unsupported internal relationship target")
    part = posixpath.normpath(target.lstrip("/") if target.startswith("/") else posixpath.join(posixpath.dirname(owner), target))
    require(part != ".." and not part.startswith("../"), "INVALID_RELATIONSHIP", "Relationship leaves the package")
    return part


def relationships(data):
    root = parse_xml(data)
    require(root["tag"] == REL_NAMESPACE + "}Relationships", "INVALID_RELATIONSHIP", "Invalid relationships root")
    links = {}
    for node in root["children"]:
        if node["tag"] == REL_NAMESPACE + "}Relationship":
            identifier = node["attrs"].get("Id")
            require(identifier and identifier not in links, "INVALID_RELATIONSHIP", "Missing or duplicate relationship ID")
            links[identifier] = node
    return root, links


def next_relationship(links):
    number = 1
    while f"rId{number}" in links:
        number += 1
    return f"rId{number}"


def relationship_id(node, kind="id"):
    return next((value for key, value in node["attrs"].items() if key.endswith("/relationships}" + kind)), None)


def png_bytes(encoded):
    require(isinstance(encoded, str), "INVALID_PNG", "newBufferBase64 must contain a PNG")
    try:
        data = base64.b64decode(encoded, validate=True)
    except (ValueError, binascii.Error) as error:
        raise PatchError("INVALID_PNG", "Invalid PNG base64") from error
    require(data.startswith(b"\x89PNG\r\n\x1a\n"), "INVALID_PNG", "Only PNG images are supported")
    offset, chunks = 8, []
    while offset < len(data):
        require(offset + 12 <= len(data), "INVALID_PNG", "Truncated PNG chunk")
        length = struct.unpack_from(">I", data, offset)[0]
        kind = data[offset + 4:offset + 8]
        end = offset + 12 + length
        require(end <= len(data), "INVALID_PNG", "PNG chunk exceeds file boundary")
        payload = data[offset + 8:end - 4]
        require(binascii.crc32(kind + payload) & 0xFFFFFFFF == struct.unpack_from(">I", data, end - 4)[0],
                "INVALID_PNG", "PNG chunk CRC mismatch")
        if not chunks:
            require(kind == b"IHDR" and length == 13, "INVALID_PNG", "PNG must start with IHDR")
            width, height, depth, color, compression, filtering, interlace = struct.unpack(">IIBBBBB", payload)
            depths = {0: {1, 2, 4, 8, 16}, 2: {8, 16}, 3: {1, 2, 4, 8}, 4: {8, 16}, 6: {8, 16}}
            require(0 < width <= 0x7FFFFFFF and 0 < height <= 0x7FFFFFFF
                    and depth in depths.get(color, set()) and compression == 0 and filtering == 0 and interlace in (0, 1),
                    "INVALID_PNG", "Unsupported PNG header")
        else:
            require(kind != b"IHDR", "INVALID_PNG", "Duplicate PNG IHDR")
        chunks.append(kind)
        offset = end
        if kind == b"IEND":
            require(length == 0 and offset == len(data), "INVALID_PNG", "Invalid PNG IEND boundary")
            break
    require(chunks and chunks[-1] == b"IEND" and b"IDAT" in chunks, "INVALID_PNG", "Incomplete PNG")
    return data


def media_references(archive):
    counts, names = {}, set(archive.namelist())
    for part in names:
        if not part.endswith(".rels") or "/_rels/" not in part:
            continue
        owner = posixpath.join(posixpath.dirname(posixpath.dirname(part)), posixpath.basename(part)[:-5])
        _, links = relationships(archive.read(part))
        image_links = [(identifier, node) for identifier, node in links.items()
                       if node["attrs"].get("Type", "").endswith("/image") and node["attrs"].get("TargetMode") != "External"]
        if not image_links:
            continue
        nodes = list(descendants(parse_xml(archive.read(owner)))) if owner in names and owner.endswith(".xml") else []
        for identifier, node in image_links:
            media = linked_part(owner, node["attrs"].get("Target", ""))
            uses = sum(relationship_id(item, "embed") == identifier or relationship_id(item) == identifier for item in nodes)
            counts[media] = counts.get(media, 0) + max(1, uses)
    return counts


def cell_hyperlink(sheet_data, rels_data, reference, target):
    root = parse_xml(sheet_data)
    namespace = root["tag"].rsplit("}", 1)[0]
    container = next((node for node in root["children"] if node["tag"] == namespace + "}hyperlinks"), None)
    matches = []
    for node in container["children"] if container else []:
        if node["tag"] != namespace + "}hyperlink":
            continue
        refs = node["attrs"].get("ref", "").split(":")
        first, last = coordinate(refs[0]), coordinate(refs[-1])
        row, column = coordinate(reference)
        if first[0] <= row <= last[0] and first[1] <= column <= last[1]:
            require(len(refs) == 1, "SHARED_HYPERLINK", "Cannot replace a hyperlink shared by a cell range")
            matches.append(node)
    require(len(matches) <= 1, "SHARED_HYPERLINK", "Multiple hyperlinks use the image cell")
    rel_root, links = relationships(rels_data)
    if matches:
        identifier = relationship_id(matches[0])
        link = links.get(identifier)
        require(link and link["attrs"].get("Type", "").endswith("/hyperlink")
                and link["attrs"].get("TargetMode") == "External",
                "INVALID_HYPERLINK", "Image cell must use an external hyperlink")
        require(sum(relationship_id(node) == identifier for node in descendants(root)) == 1,
                "SHARED_HYPERLINK", "Image hyperlink relationship is shared")
        if link["attrs"].get("Target") != target:
            rels_data = replace_attribute(rels_data, link, "Target", target)
        return sheet_data, rels_data
    identifier = next_relationship(links)
    child = (b"<" + qualified(rel_root, "Relationship") + b' Id="' + identifier.encode("ascii")
             + b'" Type="' + OFFICE_REL_NAMESPACE.encode("ascii") + b'/hyperlink" Target="' + xml_attribute(target)
             + b'" TargetMode="External"/>')
    rels_data = append_xml(rels_data, rel_root, child)
    parent = container or root
    child = (b"<" + qualified(parent, "hyperlink") + b' xmlns:r="' + OFFICE_REL_NAMESPACE.encode("ascii")
             + b'" ref="' + reference.encode("ascii") + b'" r:id="' + identifier.encode("ascii") + b'"/>')
    if container:
        sheet_data = append_xml(sheet_data, container, child)
    else:
        wrapper = qualified(root, "hyperlinks")
        child = b"<" + wrapper + b">" + child + b"</" + wrapper + b">"
        after_hyperlinks = {"printOptions", "pageMargins", "pageSetup", "headerFooter", "rowBreaks", "colBreaks",
                            "customProperties", "cellWatches", "ignoredErrors", "smartTags", "drawing", "legacyDrawing",
                            "legacyDrawingHF", "picture", "oleObjects", "controls", "webPublishItems", "tableParts", "extLst"}
        position = next((node["start"] for node in root["children"] if node["tag"].rsplit("}", 1)[-1] in after_hyperlinks),
                        root["closeStart"])
        sheet_data = apply_edits(sheet_data, [(position, position, child)])
    return sheet_data, rels_data


def image_anchor(reference, geometry, identifier, object_id):
    row, column = coordinate(reference)
    left, top, width, height = (round(geometry[key] * 9525) for key in ("leftPx", "topPx", "widthPx", "heightPx"))
    def marker(name, x, y):
        return (f"<xdr:{name}><xdr:col>{column - 1}</xdr:col><xdr:colOff>{x}</xdr:colOff>"
                f"<xdr:row>{row - 1}</xdr:row><xdr:rowOff>{y}</xdr:rowOff></xdr:{name}>")
    return (f'<xdr:twoCellAnchor xmlns:xdr="{DRAWING_NAMESPACE}" xmlns:a="{DRAWING_MAIN_NAMESPACE}" '
            f'xmlns:r="{OFFICE_REL_NAMESPACE}" editAs="oneCell">'
            + marker("from", left, top) + marker("to", left + width, top + height)
            + f'<xdr:pic><xdr:nvPicPr><xdr:cNvPr id="{object_id}" name="Picture {object_id}"/>'
            '<xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr>'
            f'<xdr:blipFill><a:blip r:embed="{identifier}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>'
            f'<xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="{width}" cy="{height}"/></a:xfrm>'
            '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic>'
            '<xdr:clientData/></xdr:twoCellAnchor>').encode("ascii")


def patch_images(archive, sheets, changed, updates):
    names = set(archive.namelist())
    get = lambda part: changed[part] if part in changed else archive.read(part)
    references = media_references(archive)
    seen = set()
    for update in updates:
        require(isinstance(update, dict) and isinstance(update.get("sheet"), str)
                and "expectedSha256" in update, "INVALID_IMAGE_UPDATE", "Image update requires sheet, cell and expectedSha256")
        reference, sheet = update.get("cell"), update["sheet"]
        position = coordinate(reference)
        require((sheet, reference) not in seen, "DUPLICATE_IMAGE", "Duplicate image slot")
        seen.add((sheet, reference))
        expected = update["expectedSha256"]
        require(expected is None or isinstance(expected, str) and re.fullmatch(r"[0-9a-f]{64}", expected),
                "INVALID_IMAGE_UPDATE", "Image expectedSha256 must be null or a SHA-256")
        png = png_bytes(update.get("newBufferBase64"))
        target, geometry = update.get("newHyperlink"), update.get("anchor")
        require(isinstance(target, str) and target.startswith("file:///") and not any(ord(char) < 32 for char in target),
                "INVALID_IMAGE_UPDATE", "newHyperlink must be a file:/// URI")
        require(isinstance(geometry, dict) and all(isinstance(geometry.get(key), (int, float))
                and not isinstance(geometry[key], bool) and math.isfinite(geometry[key])
                and (geometry[key] >= 0 if key in ("leftPx", "topPx") else geometry[key] > 0)
                and geometry[key] * 9525 <= 0x7FFFFFFF for key in ("leftPx", "topPx", "widthPx", "heightPx")),
                "INVALID_IMAGE_UPDATE", "Invalid image anchor dimensions")
        require(sheet in sheets, "MISSING_SHEET", f"Worksheet does not exist: {sheet}")
        part = sheets[sheet]
        sheet_data = get(part)
        patch_sheet(sheet_data, [{"cell": reference, "value": None}])
        sheet_root = parse_xml(sheet_data)
        drawing_nodes = [node for node in sheet_root["children"] if node["tag"].endswith("}drawing")]
        require(len(drawing_nodes) == 1, "MISSING_DRAWING", "Image updates require one existing worksheet drawing")
        sheet_rels = rels_path(part)
        _, links = relationships(get(sheet_rels))
        drawing_link = links.get(relationship_id(drawing_nodes[0]))
        require(drawing_link and drawing_link["attrs"].get("Type", "").endswith("/drawing")
                and drawing_link["attrs"].get("TargetMode") != "External",
                "INVALID_DRAWING", "Missing internal drawing relationship")
        drawing_part = linked_part(part, drawing_link["attrs"].get("Target", ""))
        drawing_data = get(drawing_part)
        drawing = parse_xml(drawing_data)
        require(drawing["tag"] == DRAWING_NAMESPACE + "}wsDr", "INVALID_DRAWING", "Unsupported worksheet drawing namespace")
        matching = []
        for anchor in drawing["children"]:
            marker = next((node for node in anchor["children"] if node["tag"] == DRAWING_NAMESPACE + "}from"), None)
            if marker:
                fields = {node["tag"].rsplit("}", 1)[-1]: node["text"] for node in marker["children"]}
                require(fields.get("row", "").isdigit() and fields.get("col", "").isdigit(),
                        "INVALID_DRAWING", "Invalid image anchor coordinates")
                if (int(fields["row"]) + 1, int(fields["col"]) + 1) == position:
                    matching.append(anchor)
        require(len(matching) <= 1, "AMBIGUOUS_IMAGE_SLOT", "Multiple drawing anchors begin at the image cell")
        drawing_rels = rels_path(drawing_part)
        rels_data = get(drawing_rels)
        rel_root, image_links = relationships(rels_data)
        if matching:
            require(expected is not None, "IMAGE_SLOT_CHANGED", "Expected an empty image slot")
            blips = [node for node in descendants(matching[0]) if node["tag"] == DRAWING_MAIN_NAMESPACE + "}blip"]
            require(len(blips) == 1, "AMBIGUOUS_IMAGE_SLOT", "Image slot must contain exactly one picture")
            link = image_links.get(relationship_id(blips[0], "embed"))
            require(link and link["attrs"].get("Type", "").endswith("/image") and link["attrs"].get("TargetMode") != "External",
                    "INVALID_DRAWING", "Missing embedded image relationship")
            media = linked_part(drawing_part, link["attrs"].get("Target", ""))
            original = get(media)
            require(media.lower().endswith(".png") and original.startswith(b"\x89PNG\r\n\x1a\n"),
                    "INVALID_PNG", "Existing image slot is not PNG")
            require(hashlib.sha256(original).hexdigest() == expected, "STALE_IMAGE", "Existing image SHA-256 changed")
            require(references.get(media) == 1, "SHARED_IMAGE", "Image media is shared by another drawing reference")
            changed[media] = png
        else:
            require(expected is None, "IMAGE_SLOT_CHANGED", "Expected image is missing from the slot")
            number = 1
            while f"xl/media/image{number}.png".lower() in {name.lower() for name in names | changed.keys()}:
                number += 1
            media = f"xl/media/image{number}.png"
            changed[media] = png
            identifier = next_relationship(image_links)
            object_ids = [int(node["attrs"]["id"]) for node in descendants(drawing)
                          if node["tag"] == DRAWING_NAMESPACE + "}cNvPr" and node["attrs"].get("id", "").isdigit()]
            changed[drawing_part] = append_xml(drawing_data, drawing, image_anchor(reference, geometry, identifier, max(object_ids, default=0) + 1))
            child = (b"<" + qualified(rel_root, "Relationship") + b' Id="' + identifier.encode("ascii") + b'" Type="'
                     + OFFICE_REL_NAMESPACE.encode("ascii") + b'/image" Target="' + xml_attribute(posixpath.relpath(media, posixpath.dirname(drawing_part))) + b'"/>')
            changed[drawing_rels] = append_xml(rels_data, rel_root, child)
            content = get("[Content_Types].xml")
            types = parse_xml(content)
            defaults = [node for node in types["children"] if node["tag"].endswith("}Default") and node["attrs"].get("Extension", "").lower() == "png"]
            require(len(defaults) <= 1 and all(node["attrs"].get("ContentType") == "image/png" for node in defaults),
                    "INVALID_PNG", "PNG content type is incompatible")
            if not defaults:
                changed["[Content_Types].xml"] = append_xml(content, types, b"<" + qualified(types, "Default") + b' Extension="png" ContentType="image/png"/>')
        changed[part], changed[sheet_rels] = cell_hyperlink(sheet_data, get(sheet_rels), reference, target)


def patch_workbook(request):
    require(isinstance(request, dict), "INVALID_REQUEST", "Request must be an object")
    require(all(isinstance(request.get(key), str) and request[key] for key in ("source", "output", "expectedSha256")),
            "INVALID_REQUEST", "source, output and expectedSha256 are required strings")
    source, output = Path(request["source"]), Path(request["output"])
    require(os.path.normcase(str(source.resolve())) != os.path.normcase(str(output.resolve())),
            "SAME_PATH", "Source and output must be different paths")
    source_bytes = source.read_bytes()
    require(hashlib.sha256(source_bytes).hexdigest() == request["expectedSha256"],
            "STALE_SOURCE", "Source SHA-256 differs from expectedSha256")
    updates = request.get("updates", [])
    require(isinstance(updates, list), "INVALID_REQUEST", "updates must be an array")
    seen, groups = set(), {}
    for update in updates:
        require(isinstance(update, dict) and isinstance(update.get("sheet"), str) and update["sheet"] and "value" in update,
                "INVALID_REQUEST", "Each update requires sheet, cell and value")
        coordinate(update.get("cell"))
        key = (update["sheet"], update["cell"])
        require(key not in seen, "DUPLICATE_CELL", f"Duplicate cell update: {key}")
        seen.add(key)
        value_xml(update["value"], b"")
        groups.setdefault(update["sheet"], []).append(update)
    image_updates = request.get("imageUpdates", [])
    require(isinstance(image_updates, list), "INVALID_REQUEST", "imageUpdates must be an array")
    changed = {}
    with zipfile.ZipFile(io.BytesIO(source_bytes)) as archive:
        names = archive.namelist()
        require(len(names) == len(set(names)), "INVALID_WORKBOOK", "Duplicate ZIP entries")
        sheets = sheet_paths(archive)
        for name, values in groups.items():
            require(name in sheets, "MISSING_SHEET", f"Worksheet does not exist: {name}")
            part = sheets[name]
            require(part not in changed, "INVALID_WORKBOOK", "Multiple worksheets reference the same part")
            original = archive.read(part)
            patched = patch_sheet(original, values)
            if patched != original:
                changed[part] = patched
        if image_updates:
            patch_images(archive, sheets, changed, image_updates)
        changed = {name: data for name, data in changed.items() if name not in names or data != archive.read(name)}
        for name, data in changed.items():
            if name.endswith((".xml", ".rels")):
                parse_xml(data)
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w") as result:
            result.comment = archive.comment
            for info in archive.infolist():
                result.writestr(info, changed.get(info.filename, archive.read(info)))
            for name, data in changed.items():
                if name not in names:
                    result.writestr(name, data, compress_type=zipfile.ZIP_DEFLATED)
    result_bytes = buffer.getvalue() if changed else source_bytes
    with zipfile.ZipFile(io.BytesIO(result_bytes)) as result:
        require(result.testzip() is None, "INVALID_OUTPUT", "Output ZIP failed its CRC check")
    created = False
    try:
        with output.open("xb") as handle:
            created = True
            handle.write(result_bytes)
    except Exception:
        if created:
            output.unlink()
        raise
    result = {"updatedCells": len(updates), "changedEntries": list(changed)}
    if "imageUpdates" in request:
        result["updatedImages"] = len(image_updates)
    return result


if __name__ == "__main__":
    try:
        request = json.loads(sys.stdin.buffer.read().decode("utf-8"))
        result = patch_workbook(request)
        sys.stdout.buffer.write(json.dumps(result, ensure_ascii=False, separators=(",", ":")).encode("utf-8") + b"\n")
    except (PatchError, OSError, ValueError, KeyError, zipfile.BadZipFile, RuntimeError) as error:
        result = {"error": {"code": getattr(error, "code", "PATCH_FAILED"), "message": str(error)}}
        sys.stdout.buffer.write(json.dumps(result, ensure_ascii=False, separators=(",", ":")).encode("utf-8") + b"\n")
        sys.exit(1)
