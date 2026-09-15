// Fixture: print-in-place pin joint (mm)
// Target: Bambu Lab P2S, 0.4 mm nozzle
// pin / print-in-place
// radial_mm = 0.4  (bore_d = pin_d + 0.8)
// axial_mm = 0.5   min_pin_mm = 4
$fn = 48;
radial_mm = 0.4;
axial_mm = 0.5;
pin_d = 4;
bore_d = 4.8;
cheek_t = 4;
rotor_t = 6;
rotor_od = 12;
axis_x = 10;
axis_z = 6;
cheek_w = 16;
base_t = 3;
lever_l = 18;

module cheek(y0) {
  translate([2, y0, 0])
    cube([cheek_w, cheek_t, rotor_od]);
}

module stator() {
  difference() {
    union() {
      cube([20, 15.8, base_t]);
      cheek(0.5);
      cheek(11.3);
    }
    translate([axis_x, -1, axis_z])
      rotate([-90, 0, 0])
        cylinder(h = 15.8 + 2, d = bore_d);
  }
}

module rotor_and_pin() {
  head_d = pin_d + 2.4;
  head_h = 1.6;
  union() {
    translate([axis_x, -head_h, axis_z])
      rotate([-90, 0, 0]) {
        cylinder(h = head_h, d = head_d);
        translate([0, 0, head_h])
          cylinder(h = 15.8, d = pin_d);
        translate([0, 0, head_h + 15.8])
          cylinder(h = head_h, d = head_d);
      }
    translate([axis_x, 4.9, axis_z])
      rotate([-90, 0, 0])
        cylinder(h = rotor_t, d = rotor_od);
    translate([axis_x, 4.9, 0])
      cube([lever_l, rotor_t, base_t]);
  }
}

// Separate solids — pin is fused to the rotor only, not the cheeks.
stator();
rotor_and_pin();
