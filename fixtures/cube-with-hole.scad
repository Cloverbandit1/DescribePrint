// Example fixture: 20 mm cube with a 5 mm through-hole
$fn = 64;
size = 20;
hole_d = 5;

difference() {
  cube(size, center = false);
  translate([size / 2, size / 2, -1])
    cylinder(h = size + 2, d = hole_d);
}
