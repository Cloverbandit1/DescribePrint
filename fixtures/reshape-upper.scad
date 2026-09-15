// Fixture: remaining unprinted upper (cut-plane mate)
// Printed stump below current_z is NOT in this mesh and cannot be reshaped.
// z=0 is the cut plane — this solid mates with the stump and prints as remaining layers.
$fn = 64;
current_z = 2.4;
remaining_h = 5.6;
size_x = 20;
size_y = 20;
hole_d = 5;

difference() {
  cube([size_x, size_y, remaining_h], center = false);
  translate([size_x / 2, size_y / 2, -1])
    cylinder(h = remaining_h + 2, d = hole_d);
}
