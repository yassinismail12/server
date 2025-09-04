const userSchema = new mongoose.Schema({
    name: String,
    email: String,
    password: String, // hashed
    role: { type: String, enum: ["admin", "client"], default: "client" },
    clientId: String, // link to their data
});
export default mongoose.model("User", userSchema);