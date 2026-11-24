import type { ActionDefinition } from "../../core/types.ts";

import { s } from "../../core/json-schema.ts";
import { defineProviderAction } from "../../core/provider-definition.ts";
import { miroBoardsReadScope, miroBoardsWriteScope } from "./scopes.ts";

const service = "miro";

const boardIdSchema = s.nonEmptyString("Unique identifier of the Miro board.");
const itemIdSchema = s.nonEmptyString("Unique identifier of the Miro board item.");
const connectorIdSchema = s.nonEmptyString("Unique identifier of the Miro connector.");
const looseRecordSchema = s.unknownObject("Additional provider fields returned by Miro.");
const miroItemTypes = [
  "text",
  "shape",
  "sticky_note",
  "image",
  "document",
  "card",
  "app_card",
  "preview",
  "frame",
  "embed",
  "doc_format",
  "data_table_format",
];

const userReferenceSchema = s.looseObject("A Miro user reference.", {
  id: s.string("Miro user identifier."),
  name: s.string("Miro user display name."),
  type: s.string("Miro resource type."),
});

const boardSchema = s.looseObject("A Miro board.", {
  id: s.string("Miro board identifier."),
  type: s.string("Miro resource type."),
  name: s.string("Miro board name."),
  description: s.string("Miro board description."),
  viewLink: s.url("URL for opening the board in Miro."),
  createdAt: s.dateTime("When the board was created."),
  modifiedAt: s.dateTime("When the board was last modified."),
  createdBy: userReferenceSchema,
  modifiedBy: userReferenceSchema,
  owner: userReferenceSchema,
  policy: looseRecordSchema,
});

const itemSchema = s.looseObject("A Miro board item.", {
  id: s.string("Miro item identifier."),
  type: s.string("Miro item type."),
  createdAt: s.dateTime("When the item was created."),
  modifiedAt: s.dateTime("When the item was last modified."),
  createdBy: userReferenceSchema,
  modifiedBy: userReferenceSchema,
  data: looseRecordSchema,
  style: looseRecordSchema,
  position: looseRecordSchema,
  geometry: looseRecordSchema,
  parent: s.nullable(looseRecordSchema),
});

const boardPaginationSchema = s.object("Offset pagination returned with Miro boards.", {
  limit: s.integer("Requested page size."),
  offset: s.nonNegativeInteger("Zero-based offset of the page."),
  size: s.nonNegativeInteger("Number of boards returned."),
});

const itemPaginationSchema = s.object("Cursor pagination returned with Miro board items.", {
  cursor: s.nullableString("Cursor for the next page, or null when no next page is available."),
});

const itemDataSchema = s.looseRequiredObject(
  "Miro item data.",
  {
    content: s.nonEmptyString("Text or HTML content displayed by the item.", { maxLength: 6000 }),
  },
  { optional: [] },
);

const stickyNoteDataSchema = s.looseRequiredObject(
  "Miro sticky note data.",
  {
    content: s.nonEmptyString("Text or supported HTML displayed by the sticky note.", { maxLength: 6000 }),
    shape: s.stringEnum("Sticky note shape.", ["square", "rectangle"]),
  },
  { optional: ["shape"] },
);
const stickyNoteUpdateDataSchema = s.looseRequiredObject(
  "Updated Miro sticky note data.",
  {
    content: s.string("Updated text or supported HTML displayed by the sticky note.", { maxLength: 6000 }),
    shape: s.stringEnum("Updated sticky note shape.", ["square", "rectangle"]),
  },
  { optional: ["content", "shape"] },
);

const itemStyleSchema = s.looseObject("Provider-native Miro item style fields.", {
  color: s.string("Text color."),
  fillColor: s.string("Item fill color."),
  fillOpacity: s.number("Fill opacity from 0 to 1.", { minimum: 0, maximum: 1 }),
  fontFamily: s.string("Font family used by a text item."),
  fontSize: s.number("Font size used by a text item.", { exclusiveMinimum: 0 }),
  textAlign: s.stringEnum("Horizontal text alignment.", ["left", "center", "right"]),
  textAlignVertical: s.stringEnum("Vertical text alignment.", ["top", "middle", "bottom"]),
});

const itemPositionSchema = s.looseObject("Position of the item on the board.", {
  x: s.number("Horizontal coordinate relative to the origin."),
  y: s.number("Vertical coordinate relative to the origin."),
  origin: s.stringEnum("Coordinate origin used by Miro.", ["center"]),
});

const stickyNoteGeometrySchema = s.looseObject("Geometry of the Miro sticky note.", {
  width: s.number("Item width.", { exclusiveMinimum: 0 }),
  height: s.number("Item height.", { exclusiveMinimum: 0 }),
  rotation: s.number("Clockwise item rotation in degrees."),
});
const stickyNoteUpdateGeometrySchema = s.object(
  "Updated size of the Miro sticky note.",
  {
    width: s.number("Updated item width.", { exclusiveMinimum: 0 }),
    height: s.number("Updated item height.", { exclusiveMinimum: 0 }),
  },
  { optional: ["width", "height"] },
);

const textGeometrySchema = s.object(
  "Geometry of the Miro text item. Miro calculates text height from its content and width.",
  {
    width: s.number("Text item width.", { exclusiveMinimum: 0 }),
    rotation: s.number("Clockwise text item rotation in degrees."),
  },
  { optional: ["width", "rotation"] },
);

const itemParentSchema = s.looseObject("Optional parent frame for the item.", {
  id: s.nonEmptyString("Identifier of the parent frame."),
});
const connectorEndpointSchema = s.object(
  "A Miro item attached to one end of the connector.",
  {
    id: itemIdSchema,
    position: s.object(
      "Relative attachment position on the item.",
      {
        x: s.number("Horizontal relative offset."),
        y: s.number("Vertical relative offset."),
      },
      { optional: ["x", "y"] },
    ),
    snapTo: s.stringEnum("Side of the item where the connector snaps.", ["auto", "top", "right", "bottom", "left"]),
  },
  { optional: ["position", "snapTo"] },
);
const connectorCaptionSchema = s.object(
  "A caption displayed on the connector.",
  {
    content: s.nonEmptyString("Caption text."),
    position: s.string("Caption position along the connector, expressed as a percentage."),
    textAlignVertical: s.stringEnum("Vertical alignment of the caption text.", ["top", "middle", "bottom"]),
  },
  { optional: ["position", "textAlignVertical"] },
);

const parentFrame = s.requiredObject("Attach to a frame by ID, or set id to null for the board canvas.", {
  id: s.nullable(s.nonEmptyString("Parent frame ID.")),
});
const coordinates = s.requireAnyProperty(
  s.object({
    x: s.number("Horizontal coordinate in board units."),
    y: s.number("Vertical coordinate in board units."),
  }),
  ["x", "y"],
);
const itemSize = {
  width: s.number("Width in board units.", { exclusiveMinimum: 0 }),
  height: s.number("Height in board units.", { exclusiveMinimum: 0 }),
};
const geometry = s.object({ ...itemSize, rotation: s.number("Clockwise rotation in degrees.") });
const shapeData = s.object({
  content: s.string("Text displayed inside the shape."),
  shape: s.stringEnum("Shape (default: rectangle).", [
    "rectangle",
    "round_rectangle",
    "circle",
    "triangle",
    "rhombus",
    "parallelogram",
    "trapezoid",
    "pentagon",
    "hexagon",
    "octagon",
    "wedge_round_rectangle_callout",
    "star",
    "flow_chart_predefined_process",
    "cloud",
    "cross",
    "can",
    "right_arrow",
    "left_arrow",
    "left_right_arrow",
    "left_brace",
    "right_brace",
  ]),
});
const bulkItem = s.requiredObject("One item in the batch; data and style depend on its type.", {
  type: s.stringEnum("Type to create.", [
    "app_card",
    "text",
    "shape",
    "sticky_note",
    "image",
    "document",
    "card",
    "frame",
    "embed",
  ]),
  data: s.optional(s.unknownObject("Type-specific Miro data, e.g. {content: 'Review'} for a sticky note.")),
  style: s.optional(s.unknownObject("Type-specific Miro style.")),
  position: s.optional(coordinates),
  geometry: s.optional(geometry),
  parent: s.optional(parentFrame),
});
const writtenItem = s.requiredObject("The resulting item; use item.id for subsequent actions.", { item: itemSchema });

export const miroActions: ActionDefinition[] = [
  defineProviderAction(service, {
    name: "list_boards",
    operationType: "read",
    description: "List Miro boards visible to the connected user with optional team, project, owner, or text filters.",
    requiredScopes: [miroBoardsReadScope],
    inputSchema: s.object(
      "Filters and pagination for listing Miro boards.",
      {
        teamId: s.nonEmptyString("Return boards visible in this Miro team."),
        projectId: s.nonEmptyString("Return boards in this Miro project or space."),
        query: s.string("Search text matched against board names and descriptions.", { maxLength: 500 }),
        owner: s.nonEmptyString("Return boards owned by this Miro user ID."),
        limit: s.integer("Maximum number of boards to return.", { minimum: 1, maximum: 50 }),
        offset: s.nonNegativeInteger("Zero-based offset of the first board to return."),
        sort: s.stringEnum("Miro board sort order.", [
          "default",
          "last_modified",
          "last_opened",
          "last_created",
          "alphabetically",
        ]),
      },
      { optional: ["teamId", "projectId", "query", "owner", "limit", "offset", "sort"] },
    ),
    outputSchema: s.object("Miro boards and pagination metadata.", {
      boards: s.array("Boards returned by Miro.", boardSchema),
      pagination: boardPaginationSchema,
    }),
  }),
  defineProviderAction(service, {
    name: "get_board",
    operationType: "read",
    description: "Get one Miro board by ID.",
    requiredScopes: [miroBoardsReadScope],
    inputSchema: s.object("Miro board identifier.", { boardId: boardIdSchema }),
    outputSchema: s.object("The requested Miro board.", { board: boardSchema }),
  }),
  defineProviderAction(service, {
    name: "create_board",
    operationType: "write",
    description: "Create a Miro board with optional team, project, and sharing policy settings.",
    requiredScopes: [miroBoardsWriteScope],
    inputSchema: s.object(
      "Properties for the new Miro board.",
      {
        name: s.nonEmptyString("Board name.", { maxLength: 60 }),
        description: s.string("Board description.", { maxLength: 300 }),
        teamId: s.nonEmptyString("Team where the board will be created."),
        projectId: s.nonEmptyString("Project or space where the board will be created."),
        policy: s.unknownObject("Provider-native Miro board policy object."),
      },
      { optional: ["description", "teamId", "projectId", "policy"] },
    ),
    outputSchema: s.object("The created Miro board.", { board: boardSchema }),
  }),
  defineProviderAction(service, {
    name: "copy_board",
    operationType: "write",
    description: "Copy an existing Miro board as a new board. Use the returned board.id to edit the copy.",
    requiredScopes: [miroBoardsWriteScope],
    inputSchema: s.requiredObject("Source board and optional overrides for the copy.", {
      boardId: boardIdSchema,
      name: s.optional(s.nonWhitespaceString("New board name.", { maxLength: 60 })),
      description: s.optional(s.string("New board description.", { maxLength: 300 })),
      teamId: s.optional(s.nonEmptyString("Destination team ID.")),
      policy: s.optional(s.unknownObject("Sharing and permissions policy for the new board.")),
    }),
    outputSchema: s.requiredObject("The copied board.", { board: boardSchema }),
  }),
  defineProviderAction(service, {
    name: "create_frame",
    operationType: "write",
    description: "Create a frame to organize board items. Use the returned item.id as their parent frame ID.",
    requiredScopes: [miroBoardsWriteScope],
    inputSchema: s.requiredObject("Board and frame properties.", {
      boardId: boardIdSchema,
      data: s.object({ title: s.string("Title displayed above the frame.") }),
      style: s.optional(s.object({ fillColor: s.string("Frame background color, e.g. #ffffff.") })),
      position: s.optional(coordinates),
      geometry: s.optional(s.object(itemSize)),
    }),
    outputSchema: writtenItem,
  }),
  defineProviderAction(service, {
    name: "move_item",
    operationType: "write",
    description:
      "Reposition an existing board item or move it into a frame without recreating it. Use parent.id = null to detach it.",
    requiredScopes: [miroBoardsWriteScope],
    inputSchema: s.requireAnyProperty(
      s.requiredObject("Item to move and its new position or parent.", {
        boardId: boardIdSchema,
        itemId: itemIdSchema,
        parent: s.optional(parentFrame),
        position: s.optional(coordinates),
      }),
      ["parent", "position"],
    ),
    outputSchema: writtenItem,
  }),
  defineProviderAction(service, {
    name: "create_items_bulk",
    operationType: "write",
    description: "Create 1–20 Miro board items in one atomic request. If any item fails, none of the batch is created.",
    requiredScopes: [miroBoardsWriteScope],
    inputSchema: s.requiredObject("Board and items to create together.", {
      boardId: boardIdSchema,
      items: s.array(bulkItem, { minItems: 1, maxItems: 20 }),
    }),
    outputSchema: s.requiredObject("Items created by the batch.", { items: s.array(itemSchema) }),
  }),
  defineProviderAction(service, {
    name: "list_items",
    operationType: "read",
    description: "List items on a Miro board with cursor pagination and an optional item-type filter.",
    requiredScopes: [miroBoardsReadScope],
    inputSchema: s.object(
      "Board, pagination, and type filter for listing Miro items.",
      {
        boardId: boardIdSchema,
        limit: s.integer("Maximum number of items to return.", { minimum: 10, maximum: 50 }),
        cursor: s.nonEmptyString("Opaque pagination cursor returned by Miro."),
        type: s.stringEnum("Miro item type.", miroItemTypes),
      },
      { optional: ["limit", "cursor", "type"] },
    ),
    outputSchema: s.object("Miro board items and pagination metadata.", {
      items: s.array("Items returned by Miro.", itemSchema),
      pagination: itemPaginationSchema,
    }),
  }),
  defineProviderAction(service, {
    name: "get_item",
    operationType: "read",
    description: "Get one item from a Miro board.",
    requiredScopes: [miroBoardsReadScope],
    inputSchema: s.object("Miro board and item identifiers.", {
      boardId: boardIdSchema,
      itemId: itemIdSchema,
    }),
    outputSchema: s.object("The requested Miro board item.", { item: itemSchema }),
  }),
  defineProviderAction(service, {
    name: "delete_item",
    operationType: "destructive",
    description: "Delete an item from a Miro board.",
    requiredScopes: [miroBoardsWriteScope],
    inputSchema: s.object("Miro board and item identifiers.", { boardId: boardIdSchema, itemId: itemIdSchema }),
    outputSchema: s.object("Confirmation of the deleted Miro item.", {
      boardId: boardIdSchema,
      itemId: itemIdSchema,
      deleted: s.literal(true, { description: "Whether the item was deleted." }),
    }),
  }),
  defineProviderAction(service, {
    name: "create_sticky_note",
    operationType: "write",
    description: "Create a sticky note on a Miro board with optional style, position, geometry, and parent frame.",
    requiredScopes: [miroBoardsWriteScope],
    inputSchema: s.object(
      "Properties for a new Miro sticky note.",
      {
        boardId: boardIdSchema,
        data: stickyNoteDataSchema,
        style: itemStyleSchema,
        position: itemPositionSchema,
        geometry: stickyNoteGeometrySchema,
        parent: itemParentSchema,
      },
      { optional: ["style", "position", "geometry", "parent"] },
    ),
    outputSchema: s.object("The created Miro sticky note.", { item: itemSchema }),
  }),
  defineProviderAction(service, {
    name: "create_text",
    operationType: "write",
    description: "Create a text item on a Miro board with optional style, position, geometry, and parent frame.",
    requiredScopes: [miroBoardsWriteScope],
    inputSchema: s.object(
      "Properties for a new Miro text item.",
      {
        boardId: boardIdSchema,
        data: itemDataSchema,
        style: itemStyleSchema,
        position: itemPositionSchema,
        geometry: textGeometrySchema,
        parent: itemParentSchema,
      },
      { optional: ["style", "position", "geometry", "parent"] },
    ),
    outputSchema: s.object("The created Miro text item.", { item: itemSchema }),
  }),
  defineProviderAction(service, {
    name: "create_shape",
    operationType: "write",
    description: "Create a shape on a Miro board.",
    requiredScopes: [miroBoardsWriteScope],
    inputSchema: s.object(
      "Properties for a new Miro shape.",
      {
        boardId: boardIdSchema,
        data: shapeData,
        style: itemStyleSchema,
        position: itemPositionSchema,
        geometry: stickyNoteGeometrySchema,
        parent: itemParentSchema,
      },
      { optional: ["data", "style", "position", "geometry", "parent"] },
    ),
    outputSchema: s.object("The created Miro shape.", { item: itemSchema }),
  }),
  defineProviderAction(service, {
    name: "update_sticky_note",
    operationType: "write",
    description: "Update a sticky note on a Miro board.",
    requiredScopes: [miroBoardsWriteScope],
    inputSchema: s.object(
      "Miro sticky note identifier and fields to update.",
      {
        boardId: boardIdSchema,
        itemId: itemIdSchema,
        data: stickyNoteUpdateDataSchema,
        style: itemStyleSchema,
        position: itemPositionSchema,
        geometry: stickyNoteUpdateGeometrySchema,
        parent: itemParentSchema,
      },
      { optional: ["data", "style", "position", "geometry", "parent"] },
    ),
    outputSchema: s.object("The updated Miro sticky note.", { item: itemSchema }),
  }),
  defineProviderAction(service, {
    name: "create_connector",
    operationType: "write",
    description: "Create a connector between two items on a Miro board.",
    requiredScopes: [miroBoardsWriteScope],
    inputSchema: s.object(
      "Properties for a new Miro connector.",
      {
        boardId: boardIdSchema,
        startItem: connectorEndpointSchema,
        endItem: connectorEndpointSchema,
        shape: s.stringEnum("Connector line shape.", ["straight", "elbowed", "curved"]),
        captions: s.array("Captions displayed on the connector.", connectorCaptionSchema),
        style: looseRecordSchema,
      },
      { optional: ["shape", "captions", "style"] },
    ),
    outputSchema: s.object("The created Miro connector.", { connector: looseRecordSchema }),
  }),
  defineProviderAction(service, {
    name: "delete_connector",
    operationType: "destructive",
    description: "Delete a connector from a Miro board.",
    requiredScopes: [miroBoardsWriteScope],
    inputSchema: s.object("Miro board and connector identifiers.", {
      boardId: boardIdSchema,
      connectorId: connectorIdSchema,
    }),
    outputSchema: s.object("Confirmation of the deleted Miro connector.", {
      boardId: boardIdSchema,
      connectorId: connectorIdSchema,
      deleted: s.literal(true, { description: "Whether the connector was deleted." }),
    }),
  }),
];
