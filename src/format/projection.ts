// How deep a plane looks in text. Projection only ever changes whitespace the parser
// ignores: indentation, the gap between cells, and column-alignment padding.

export type Projection = "flat" | "perspective" | "strong";

export const PROJECTIONS: readonly Projection[] = ["flat", "perspective", "strong"];

export type PlaneStyle = {
  indent: number; // spaces before every line of the plane
  gap: number; // spaces between cells
  align: boolean; // pad cells so columns line up
};

// Definitions in the ※ section are drawn flat, whatever the projection.
export const APPENDIX_STYLE: PlaneStyle = { indent: 0, gap: 1, align: true };

export function planeStyle(projection: Projection, z: number): PlaneStyle {
  switch (projection) {
    case "flat":
      return { indent: 0, gap: 1, align: true };
    case "perspective":
      return { indent: 4 * z, gap: 1, align: true };
    case "strong":
      // Deeper planes are drawn narrower: wide gaps up front, packed rows at depth.
      return { indent: 5 * z, gap: Math.max(0, 2 - z), align: z <= 1 };
  }
}

export function isProjection(value: string): value is Projection {
  return (PROJECTIONS as readonly string[]).includes(value);
}
