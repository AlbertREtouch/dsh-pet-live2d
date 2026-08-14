import { defaultPetsRoot, listPets, readPet } from "../lib/index.js";

const root = defaultPetsRoot();
console.log("root:", JSON.stringify(root));
const pets = listPets(root);
console.log("pets:", JSON.stringify(pets, null, 2));
console.log("readPet direct:", JSON.stringify(readPet(root, "dsh-kitten"), null, 2));
