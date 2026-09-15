// Example fixture: parametric drawer knob, 40 mm diameter (mm)
$fn = 64;
d = 40;
stem_h = 12;
flange_h = 4;
hole = 5;

difference() {
  union() {
    cylinder(h = flange_h, d = d * 0.55);
    translate([0, 0, flange_h])
      cylinder(h = stem_h, d1 = d * 0.32, d2 = d * 0.22);
    translate([0, 0, flange_h + stem_h])
      sphere(d = d);
  }
  translate([0, 0, -1])
    cylinder(h = flange_h + stem_h + 2, d = hole);
  translate([-d, -d, -d])
    cube([d * 2, d * 2, d]);
}
