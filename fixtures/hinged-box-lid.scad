// Fixture: print-in-place hinged box lid (mm)
// Target: Bambu Lab P2S, 0.4 mm nozzle
// hinge / print-in-place
// radial_mm = 0.4  (bore_d = pin_d + 0.8)
// axial_mm = 0.5   min_pin_mm = 4
$fn = 48;
radial_mm = 0.4;
axial_mm = 0.5;
pin_d = 4;
bore_d = 4.8;
knuckle_od = 8;
knuckle_len = 6;
axis_y = 0;
axis_z = 4;
box_w = 40;
box_d = 28;
box_h = 14;
wall = 2;
lid_t = 2.4;
lid_y0 = -30.4;

module knuckle(x0) {
  translate([x0, axis_y, axis_z])
    rotate([0, 90, 0])
      cylinder(h = knuckle_len, d = knuckle_od);
}

module bore_cut(x0) {
  translate([x0 - 0.4, axis_y, axis_z])
    rotate([0, 90, 0])
      cylinder(h = knuckle_len + 0.8, d = bore_d);
}

module box_body() {
  difference() {
    union() {
      difference() {
        cube([box_w, box_d, box_h]);
        translate([wall, wall, wall])
          cube([box_w - wall * 2, box_d - wall * 2, box_h]);
      }
      knuckle(10.5);
      knuckle(23.5);
    }
    bore_cut(10.5);
    bore_cut(23.5);
  }
}

module lid() {
  difference() {
    union() {
      translate([0, lid_y0, 0])
        cube([box_w, box_d, lid_t]);
      knuckle(17);
    }
    bore_cut(17);
  }
}

module hinge_pin() {
  head_d = pin_d + 2.4;
  head_h = 1.6;
  translate([10 - head_h, axis_y, axis_z])
    rotate([0, 90, 0]) {
      cylinder(h = head_h, d = head_d);
      translate([0, 0, head_h])
        cylinder(h = 20, d = pin_d);
      translate([0, 0, head_h + 20])
        cylinder(h = head_h, d = head_d);
    }
}

// Separate solids — do not union. Print-in-place clearances are the gaps.
box_body();
lid();
hinge_pin();
