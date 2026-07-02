import { mountDetector } from "./detector.js";
import { mountWall } from "./wall.js";
import { mountTanks } from "./tanks.js";

mountDetector(document.getElementById("detector-app"));
mountWall(document.getElementById("wall-app"));
mountTanks(document.getElementById("tanks-app"));
