// Fixture: print-in-place ball joint (mm)
// Target: Bambu Lab P2S, 0.4 mm nozzle
// ball / print-in-place
// radial_mm = 0.5  (bore_d = pin_d + 1)
// axial_mm = 0.5   min_pin_mm = 4
$fn = 48;
radial_mm = 0.5;
axial_mm = 0.5;
ball_d = 10;
cavity_d = 11;
wall = 2.4;
stem_d = 4;
neck_d = 5;
socket_w = 20;
socket_d = 16;
socket_h = 15.8;
cx = 10;
cy = 8;
cz = 7.9;

module socket() {
  difference() {
    union() {
      cube([socket_w, socket_d, socket_h]);
      translate([cx, cy, cz])
        rotate([-90, 0, 0])
          cylinder(h = socket_d / 2 + 6, d = neck_d + wall * 2);
    }
    translate([cx, cy, cz])
      sphere(d = cavity_d);
    translate([cx, cy - 1, cz])
      rotate([-90, 0, 0])
        cylinder(h = socket_d / 2 + 10, d = neck_d);
  }
}

module ball_and_stem() {
  translate([cx, cy, cz]) {
    sphere(d = ball_d);
    rotate([-90, 0, 0])
      cylinder(h = 22, d = stem_d);
  }
}

// Separate solids — captive ball inside the socket. Do not union.
socket();
ball_and_stem();
