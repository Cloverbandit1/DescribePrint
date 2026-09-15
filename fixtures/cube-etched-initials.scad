// Fixture: 20mm cube with etched initials on the front (mm)
// Region default (unspecified): largest vertical face / front (+Y).
// Etch depth 0.6 mm — visible, leaves #11 1.6 mm walls on this solid host.
// Honest stub: block initials, not Style2Fab / text().
$fn = 48;
size = 20;
etch_depth = 0.6;
difference() {
  cube(size, center = false);
  union() {
    translate([4.4, 19.4, 6]) cube([1.3, 0.8, 8]);
    translate([4.4, 19.4, 6]) cube([4.2, 0.8, 1.3]);
    translate([4.4, 19.4, 12.7]) cube([4.2, 0.8, 1.3]);
    translate([7.9, 19.4, 7.1]) cube([1.4, 0.8, 5.8]);
    translate([11.6, 19.4, 6]) cube([1.3, 0.8, 8]);
    translate([11.6, 19.4, 9.4]) cube([4.4, 0.8, 1.3]);
    translate([11.6, 19.4, 12.7]) cube([4.4, 0.8, 1.3]);
    translate([15, 19.4, 9.4]) cube([1.4, 0.8, 4.6]);
  }
}
