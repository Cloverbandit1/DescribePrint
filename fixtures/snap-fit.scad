// Fixture: print-in-place snap-fit clip (mm)
// Target: Bambu Lab P2S, 0.4 mm nozzle
// snap / print-in-place
// radial_mm = 0.3  (bore_d = pin_d + 0.6)
// axial_mm = 0.5   min_pin_mm = 4
$fn = 48;
radial_mm = 0.3;
axial_mm = 0.5;
beam_t = 1.6;
beam_h = 8;
beam_l = 20;
overhang = 1.6;
window_w = 2.2;
window_h = 8.6;

module catch_body() {
  difference() {
    union() {
      translate([0, 14, 0])
        cube([14, 3, 12]);
      // Foot behind the head so it cannot fuse to the beam.
      translate([0, 20.8, 0])
        cube([14, 8, 2.4]);
    }
    translate([3.7, 13.6, 1.7])
      cube([window_w, 3.8, window_h]);
  }
}

module snap_hook() {
  translate([0, 0, 0]) {
    translate([4, 0, 0])
      cube([beam_t, 4, 2.4]);
    translate([4, 0, 2])
      cube([beam_t, beam_l, beam_h]);
    translate([2.4, 17.5, 2])
      cube([4.8, 3, beam_h]);
  }
}

// Separate solids — do not union. Hook flexes in X (XY plane).
catch_body();
snap_hook();
